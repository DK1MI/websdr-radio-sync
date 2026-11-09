package io.github.dk1mi.websdrradiosync

import android.app.Activity
import android.app.AlertDialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The native half of the panel's navigator.serial: USB-serial adapters (FTDI, CP210x, CH34x,
 * PL2303, CDC-ACM) through usb-serial-for-android. A port is identified by
 * "deviceName#portIndex", because some radios (CP2105) have two ports on one device.
 */
class UsbSerialBridge(private val activity: Activity, private val host: PanelHost) {
    private val usb = activity.getSystemService(Context.USB_SERVICE) as UsbManager
    private val exec = Executors.newSingleThreadExecutor() // keeps open/write/close in order
    private val permissionAction = activity.packageName + ".USB_PERMISSION"
    private val permissionWaiters = HashMap<String, (Boolean) -> Unit>() // main thread only
    private val open = ConcurrentHashMap<Int, OpenPort>()
    private val nextHandle = AtomicInteger(1)

    private class OpenPort(val key: String, val deviceName: String, val port: UsbSerialPort) {
        var io: SerialInputOutputManager? = null
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val dev = deviceOf(i) ?: return
            when (i.action) {
                permissionAction -> permissionWaiters.remove(dev.deviceName)
                    ?.invoke(i.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
                UsbManager.ACTION_USB_DEVICE_DETACHED -> deviceGone(dev.deviceName)
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(permissionAction)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(activity, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    private fun ports(): List<Pair<String, UsbSerialPort>> =
        UsbSerialProber.getDefaultProber().findAllDrivers(usb).flatMap { d ->
            d.ports.mapIndexed { i, p -> "${d.device.deviceName}#$i" to p }
        }

    private fun describe(key: String, port: UsbSerialPort): JSONObject {
        val d = port.driver.device
        val name = try {
            listOfNotNull(d.manufacturerName, d.productName).joinToString(" ")
        } catch (_: SecurityException) { "" }.ifBlank { port.driver.javaClass.simpleName.removeSuffix("SerialDriver") }
        val multi = if (port.driver.ports.size > 1) " · port ${port.portNumber + 1}" else ""
        return JSONObject()
            .put("key", key)
            .put("vendorId", d.vendorId)
            .put("productId", d.productId)
            .put("label", "%s%s (%04X:%04X)".format(name, multi, d.vendorId, d.productId))
    }

    /** The port chooser (navigator.serial.requestPort). Main thread. */
    fun requestPort(reply: Reply) {
        val list = ports()
        if (list.isEmpty()) {
            AlertDialog.Builder(activity)
                .setTitle("No USB serial adapter found")
                .setMessage("Connect the radio's USB cable (through an OTG adapter if needed) and try again.")
                .setPositiveButton(android.R.string.ok, null)
                .setOnDismissListener { reply.fail("NotFoundError", "No port selected.") }
                .show()
            return
        }
        var picked = false
        val labels = list.map { (k, p) -> describe(k, p).getString("label") }.toTypedArray()
        AlertDialog.Builder(activity)
            .setTitle("Radio serial port")
            .setItems(labels) { _, which ->
                picked = true
                val (key, port) = list[which]
                withPermission(port.driver.device) { granted ->
                    if (granted) reply.ok(describe(key, port).toString())
                    else reply.fail("NotFoundError", "USB access was not allowed.")
                }
            }
            .setOnDismissListener { if (!picked) reply.fail("NotFoundError", "No port selected.") }
            .show()
    }

    private fun withPermission(dev: UsbDevice, cb: (Boolean) -> Unit) {
        if (usb.hasPermission(dev)) return cb(true)
        permissionWaiters[dev.deviceName] = cb
        val intent = Intent(permissionAction).setPackage(activity.packageName)
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        usb.requestPermission(dev, PendingIntent.getBroadcast(activity, 0, intent, flags))
    }

    /** Ports the app already has access to (navigator.serial.getPorts). */
    fun getPorts(reply: Reply) = exec.execute {
        val arr = JSONArray()
        for ((k, p) in ports()) if (usb.hasPermission(p.driver.device)) arr.put(describe(k, p))
        reply.ok(arr.toString())
    }

    fun open(args: JSONObject, reply: Reply) = exec.execute {
        val key = args.optString("key")
        val port = ports().firstOrNull { it.first == key }?.second
            ?: return@execute reply.fail("NotFoundError", "The device has been lost.")
        if (open.values.any { it.key == key }) return@execute reply.fail("InvalidStateError", "The port is already open.")
        val dev = port.driver.device
        if (!usb.hasPermission(dev)) return@execute reply.fail("SecurityError", "No USB access to this device.")
        val conn = usb.openDevice(dev) ?: return@execute reply.fail("NetworkError", "Failed to open the USB device.")
        try {
            port.open(conn)
            val stopBits = if (args.optInt("stopBits", 1) == 2) UsbSerialPort.STOPBITS_2 else UsbSerialPort.STOPBITS_1
            val parity = when (args.optString("parity")) {
                "even" -> UsbSerialPort.PARITY_EVEN
                "odd" -> UsbSerialPort.PARITY_ODD
                else -> UsbSerialPort.PARITY_NONE
            }
            port.setParameters(args.optInt("baudRate", 9600), args.optInt("dataBits", 8), stopBits, parity)
            if (args.optString("flowControl") == "hardware") {
                try {
                    port.setFlowControl(UsbSerialPort.FlowControl.RTS_CTS)
                } catch (_: UnsupportedOperationException) {
                    // Chip without RTS/CTS support in the driver; panel.js still checks CTS itself.
                }
            }
            val h = nextHandle.getAndIncrement()
            val op = OpenPort(key, dev.deviceName, port)
            val io = SerialInputOutputManager(port, object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    host.event("serialData", JSONObject()
                        .put("handle", h)
                        .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
                        .toString())
                }
                override fun onRunError(e: Exception) {
                    if (open.remove(h) != null) {
                        exec.execute { closeQuietly(op) }
                        lost(h, e.message ?: "I/O error")
                    }
                }
            })
            op.io = io
            open[h] = op
            io.start()
            reply.ok(JSONObject().put("handle", h).toString())
        } catch (e: Exception) {
            try { port.close() } catch (_: Exception) {}
            try { conn.close() } catch (_: Exception) {}
            reply.fail("NetworkError", "Failed to open serial port: ${e.message}")
        }
    }

    fun write(args: JSONObject, reply: Reply) = exec.execute {
        val op = open[args.optInt("handle")] ?: return@execute reply.fail("InvalidStateError", "The port is closed.")
        try {
            op.port.write(Base64.decode(args.getString("data"), Base64.DEFAULT), 2500)
            reply.ok("null")
        } catch (e: Exception) {
            reply.fail("NetworkError", e.message ?: "write failed")
        }
    }

    fun setSignals(args: JSONObject, reply: Reply) = exec.execute {
        val op = open[args.optInt("handle")] ?: return@execute reply.fail("InvalidStateError", "The port is closed.")
        try {
            if (args.has("dtr")) op.port.dtr = args.getBoolean("dtr")
            if (args.has("rts")) op.port.rts = args.getBoolean("rts")
            reply.ok("null")
        } catch (e: Exception) {
            reply.fail("NotSupportedError", e.message ?: "cannot set signals")
        }
    }

    fun getSignals(args: JSONObject, reply: Reply) = exec.execute {
        val op = open[args.optInt("handle")] ?: return@execute reply.fail("InvalidStateError", "The port is closed.")
        try {
            val p = op.port
            fun opt(f: () -> Boolean) = try { f() } catch (_: Exception) { false }
            reply.ok(JSONObject()
                .put("clearToSend", p.cts) // no CTS reading -> error, so panel.js won't warn wrongly
                .put("dataSetReady", opt { p.dsr })
                .put("dataCarrierDetect", opt { p.cd })
                .put("ringIndicator", opt { p.ri })
                .toString())
        } catch (e: Exception) {
            reply.fail("NotSupportedError", e.message ?: "cannot read signals")
        }
    }

    fun close(args: JSONObject, reply: Reply) = exec.execute {
        open.remove(args.optInt("handle"))?.let { closeQuietly(it) }
        reply.ok("null")
    }

    /** The radio was plugged in while the app runs, and Android granted access through the intent filter. */
    fun onAttached(dev: UsbDevice) {
        if (!usb.hasPermission(dev) || UsbSerialProber.getDefaultProber().probeDevice(dev) == null) return
        val info = JSONObject().put("usbVendorId", dev.vendorId).put("usbProductId", dev.productId)
        host.event("runtimeMessage", JSONObject().put("type", "port-granted").put("info", info).toString())
    }

    private fun deviceGone(deviceName: String) {
        for ((h, op) in open) {
            if (op.deviceName == deviceName && open.remove(h) != null) {
                exec.execute { closeQuietly(op) }
                lost(h, "The device has been lost.")
            }
        }
    }

    private fun lost(handle: Int, message: String) =
        host.event("serialLost", JSONObject().put("handle", handle).put("message", message).toString())

    private fun closeQuietly(op: OpenPort) {
        try { op.io?.stop() } catch (_: Exception) {}
        try { op.port.close() } catch (_: Exception) {}
    }

    fun shutdown() {
        try { activity.unregisterReceiver(receiver) } catch (_: Exception) {}
        for (h in open.keys.toList()) open.remove(h)?.let { op -> exec.execute { closeQuietly(op) } }
        exec.shutdown()
    }

    @Suppress("DEPRECATION")
    private fun deviceOf(i: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else i.getParcelableExtra(UsbManager.EXTRA_DEVICE)
}

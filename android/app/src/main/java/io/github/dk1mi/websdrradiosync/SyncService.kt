package io.github.dk1mi.websdrradiosync

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.ServiceCompat

/**
 * Keeps the app alive while it is in the background or the screen is off: a foreground service
 * with an ongoing notification (radio and SDR state, Stop button), plus a CPU wake lock and a
 * Wi-Fi lock so the SDR audio stream and the radio polling keep going.
 * Runs exactly as long as MainActivity: started in its onCreate, stopped in its onDestroy.
 */
class SyncService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var title = "Web SDR Radio Sync"
    private var text = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Sync running", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while the app keeps the radio and the web SDR in sync"
                setShowBadge(false)
            }
        )
        ServiceCompat.startForeground(
            this, NOTIFICATION_ID, build(),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        )
        acquireLocks()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            onStopRequested?.invoke() // MainActivity closes; its onDestroy stops this service
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** New notification text from the panel (radio and SDR state). */
    fun update(title: String, text: String) {
        if (title == this.title && text == this.text) return
        this.title = title
        this.text = text
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build())
    }

    private fun build(): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, SyncService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    @SuppressLint("WakelockTimeout") // held for as long as the user keeps the app running
    private fun acquireLocks() {
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WebSdrRadioSync:sync")
            .apply { setReferenceCounted(false); acquire() }
        @Suppress("DEPRECATION")
        wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WebSdrRadioSync:stream")
            .apply { setReferenceCounted(false); acquire() }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        onStopRequested?.invoke()
        stopSelf()
    }

    override fun onDestroy() {
        try { wakeLock?.release() } catch (_: Exception) {}
        try { wifiLock?.release() } catch (_: Exception) {}
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "sync"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_STOP = "stop"

        /** Same process, so the activity talks to the running service directly. Main thread only. */
        var instance: SyncService? = null
            private set
        var onStopRequested: (() -> Unit)? = null
    }
}

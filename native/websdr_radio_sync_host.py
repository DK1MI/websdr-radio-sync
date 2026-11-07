#!/usr/bin/env -S python3 -I
"""Native-messaging helper for the Web SDR Radio Sync extension.

Chrome starts this program when the panel selects "Hamlib (rigctld)". It either
starts rigctld for the chosen model and serial device, or connects to a rigctld
that is already running, and relays frequency/mode/PTT requests to it.
rigctld is stopped when Chrome closes the connection.
"""
import glob
import json
import os
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

VERSION = 1


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (n,) = struct.unpack("=I", raw)
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send_msg(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


class RigError(Exception):
    def __init__(self, msg, rprt=None):
        super().__init__(msg)
        self.rprt = rprt


class Rig:
    def __init__(self):
        self.sock = None
        self.file = None
        self.proc = None
        self.errlog = None  # rigctld stderr goes to a temp file so a full pipe can't block it

    def close(self):
        if self.file:
            try:
                self.file.close()
            except OSError:
                pass
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = self.file = None
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.proc = None
        if self.errlog:
            self.errlog.close()
            self.errlog = None

    def errtail(self):
        if not self.errlog:
            return ""
        self.errlog.seek(0)
        lines = [ln.strip() for ln in self.errlog.read().decode("utf-8", "replace").splitlines()
                 if ln.strip() and "caught signal" not in ln]
        self.errlog.seek(0, 2)
        return "; ".join(lines[-2:])

    def check_alive(self):
        if self.proc and self.proc.poll() is not None:
            raise RigError("rigctld could not open the radio: " + (self.errtail() or f"exit code {self.proc.returncode}"))

    def connect(self, host, port, deadline):
        last = None
        while time.monotonic() < deadline:
            self.check_alive()
            try:
                self.sock = socket.create_connection((host, port), timeout=1)
                self.sock.settimeout(5)
                self.file = self.sock.makefile("rwb")
                return
            except OSError as e:
                last = e
                time.sleep(0.2)
        raise RigError(f"cannot connect to rigctld at {host}:{port}: {last}")

    def cmd(self, line):
        """Send one extended-protocol command, return ({key: value}, rprt)."""
        self.check_alive()
        if not self.file:
            raise RigError("not connected to rigctld")
        try:
            self.file.write(("+" + line + "\n").encode())
            self.file.flush()
            out = {}
            while True:
                raw = self.file.readline()
                if not raw:
                    raise RigError("rigctld closed the connection")
                text = raw.decode("utf-8", "replace").rstrip("\r\n")
                if text.startswith("RPRT"):
                    return out, int(text.split()[1])
                key, _, val = text.partition(":")
                out[key.strip()] = val.strip()
        except socket.timeout:
            raise RigError(f"rigctld did not answer '{line}' (radio not responding?)")
        except OSError as e:
            # rigctld drops the client when it cannot open the radio, and only flushes
            # its stderr (which says why) when it exits, so stop it and read that.
            if self.proc:
                self.proc.terminate()
                try:
                    self.proc.wait(3)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                tail = self.errtail()
                raise RigError(f"rigctld could not open the radio: {tail}" if tail else f"rigctld connection error: {e}")
            raise RigError(f"rigctld connection error: {e}")

    def must(self, line):
        out, rprt = self.cmd(line)
        if rprt != 0:
            raise RigError(f"'{line}' failed: RPRT {rprt}{rprt_text(rprt)}", rprt)
        return out


def rprt_text(n):
    return {
        -1: " (invalid parameter)", -4: " (not implemented)", -5: " (timeout: radio not answering)",
        -6: " (I/O error)", -8: " (protocol error)", -9: " (command rejected by radio)",
        -11: " (not available)", -12: " (VFO not targetable)",
    }.get(n, "")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def list_models():
    exe = shutil.which("rigctl")
    if not exe:
        raise RigError("rigctl not found: install Hamlib (e.g. 'pacman -S hamlib' / 'apt install libhamlib-utils')")
    text = subprocess.run([exe, "-l"], capture_output=True, text=True, timeout=10).stdout
    lines = text.splitlines()
    header = lines[0]
    c_mfg, c_model, c_ver, c_status = (header.index(k) for k in ("Mfg", "Model", "Version", "Status"))
    models = []
    for ln in lines[1:]:
        num = ln[:c_mfg].strip()
        if not num.isdigit():
            continue
        models.append({
            "id": int(num),
            "mfg": ln[c_mfg:c_model].strip(),
            "model": ln[c_model:c_ver].strip(),
            "status": ln[c_status:].split()[0] if ln[c_status:].strip() else "",
        })
    return models


def list_ports():
    ports = []
    for p in sorted(glob.glob("/dev/serial/by-id/*")):
        ports.append({"path": p, "label": os.path.basename(p) + " → " + os.path.basename(os.path.realpath(p))})
    seen = {os.path.realpath(p["path"]) for p in ports}
    for pat in ("/dev/ttyUSB*", "/dev/ttyACM*", "/dev/cu.*", "/dev/rfcomm*"):
        for p in sorted(glob.glob(pat)):
            if p not in seen:
                ports.append({"path": p, "label": p})
    return ports


def main():
    rig = Rig()
    try:
        while True:
            msg = read_msg()
            if msg is None:
                break
            mid = msg.get("id")
            op = msg.get("op")
            try:
                if op == "hello":
                    res = {"version": VERSION, "rigctld": shutil.which("rigctld")}
                elif op == "list-models":
                    res = {"models": list_models()}
                elif op == "list-ports":
                    res = {"ports": list_ports()}
                elif op == "start":
                    rig.close()
                    exe = shutil.which("rigctld")
                    if not exe:
                        raise RigError("rigctld not found: install Hamlib")
                    dev = msg["device"]
                    if dev.startswith("/") and not os.path.exists(dev):
                        raise RigError(f"device {dev} does not exist (adapter unplugged?)")
                    port = free_port()
                    args = [exe, "-m", str(int(msg["model"])), "-r", msg["device"],
                            "-T", "127.0.0.1", "-t", str(port)]
                    if msg.get("baud"):
                        args += ["-s", str(int(msg["baud"]))]
                    args += shlex.split(msg.get("extra") or "")
                    rig.errlog = tempfile.TemporaryFile()
                    rig.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                                stdout=subprocess.DEVNULL, stderr=rig.errlog)
                    rig.connect("127.0.0.1", port, time.monotonic() + 15)
                    res = {"cmdline": shlex.join(args[1:]), "info": info(rig)}
                    rig.check_alive()  # get_info may have shown that rigctld can't open the radio
                elif op == "connect":
                    rig.close()
                    rig.connect(msg.get("host") or "127.0.0.1", int(msg.get("port") or 4532), time.monotonic() + 5)
                    res = {"info": info(rig)}
                elif op == "poll":
                    hz = int(float(rig.must("f").get("Frequency", "0")))
                    m = rig.must("m")
                    ptt_out, ptt_rc = rig.cmd("t")
                    vfo_out, vfo_rc = rig.cmd("v")
                    res = {
                        "hz": hz,
                        "mode": m.get("Mode"),
                        "ptt": ptt_rc == 0 and ptt_out.get("PTT", "0") not in ("0", ""),
                        "vfo": vfo_out.get("VFO") if vfo_rc == 0 else None,
                    }
                elif op == "set_freq":
                    rig.must(f"F {int(msg['hz'])}")
                    res = {}
                elif op == "set_mode":
                    mode = str(msg["mode"])
                    if not mode.isalnum():
                        raise RigError("bad mode")
                    rig.must(f"M {mode} -1")  # -1 = keep the current passband
                    res = {}
                elif op == "stop":
                    rig.close()
                    res = {}
                else:
                    raise RigError(f"unknown op {op!r}")
                send_msg({"id": mid, **res})
            except RigError as e:
                send_msg({"id": mid, "error": str(e), "rprt": e.rprt})
            except Exception as e:  # keep the helper alive; report to the panel
                send_msg({"id": mid, "error": f"{type(e).__name__}: {e}"})
    finally:
        rig.close()


def info(rig):
    try:
        out, rc = rig.cmd("\\get_info")
    except RigError:
        return ""
    return out.get("Info", "") if rc == 0 else ""


if __name__ == "__main__":
    main()

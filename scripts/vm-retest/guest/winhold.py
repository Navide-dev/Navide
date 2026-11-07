# winhold.py <root> hold <port> | release: occupy the webhook port with a detached python listener (pid in hold.pid),
# or end that recorded pid and confirm the port is free. Only the recorded pid is ever ended.
import os, socket, subprocess, sys, time
root, mode = sys.argv[1:3]; pidf = os.path.join(root, "hold.pid")
def busy(port):
    s = socket.socket()
    try: s.bind(("127.0.0.1", port)); return False
    except OSError: return True
    finally: s.close()
if mode == "hold":
    port = int(sys.argv[3])
    code = ("import socket,time;s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);"
            f"s.bind(('127.0.0.1',{port}));s.listen();time.sleep(900)")
    p = subprocess.Popen([sys.executable, "-c", code], creationflags=0x00000008 | 0x00000200,  # DETACHED_PROCESS | NEW_PROCESS_GROUP
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    open(pidf, "w").write(f"{p.pid} {port}"); time.sleep(1.5)
    print(f"holding {port} pid {p.pid} port-busy={busy(port)} at {time.strftime('%H:%M:%S')}")
else:
    pid, port = map(int, open(pidf).read().split())
    subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    time.sleep(1); print(f"released pid {pid} at {time.strftime('%H:%M:%S')} port-busy={busy(port)}")

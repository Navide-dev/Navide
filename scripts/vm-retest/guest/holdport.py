# holdport.py <port>: occupy a localhost port for 10 minutes (listener-retry test); the caller records and ends its PID
import socket,sys,time
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(("127.0.0.1",int(sys.argv[1])));s.listen();time.sleep(600)

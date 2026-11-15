//! Session: one CLI process on its own PTY (Unix). Same child setup as
//! main's `osplat._posix` spawn: a new session, the PTY slave as the
//! controlling terminal and stdio, SIGINT/SIGQUIT/SIGTSTP back to default,
//! and a non-blocking master. Windows ConPTY is not built.
#![cfg(unix)]
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;

/// Serialises PTY creation with spawning: macOS `openpty` is not safe from
/// several threads at once, and a descriptor created between `openpty` and
/// its close-on-exec flag would leak into another child (measured in the
/// evaluation crate, which this module reuses).
///
/// Also seen here, on macOS, in this crate's own tests: a child forked while
/// another thread had a SQLite connection open (the system library) was
/// killed with signal 9 before it wrote anything, in 12 of about 58 runs of
/// the unit tests; in none of 16 with the SQLite test left out, and none of
/// 16 once its connection was opened under this lock. Why is not
/// established. Before PTY ownership is wired in, a process that both reads
/// SQLite stores and forks panes has to keep the two apart.
pub(crate) static FD_FORK_LOCK: Mutex<()> = Mutex::new(());

pub struct Spawn<'a> {
    pub argv: &'a [String],
    pub cwd: &'a std::path::Path,
    pub env: &'a [(String, String)],
    pub rows: u16,
    pub cols: u16,
}

pub struct Session {
    master: OwnedFd,
    child: Child,
}

fn check(rc: libc::c_int) -> io::Result<()> {
    if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

fn resize_fd(fd: RawFd, rows: u16, cols: u16) -> io::Result<()> {
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // SAFETY: a live PTY master and a correctly sized winsize.
    check(unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) })
}

impl Session {
    pub fn spawn(spec: &Spawn) -> io::Result<Session> {
        let program = spec.argv.first().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?;
        let gate = FD_FORK_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut master, mut slave) = (-1, -1);
        // SAFETY: out-parameters for two descriptors; no name, termios or size.
        check(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) })?;
        // SAFETY: openpty succeeded and hands over each descriptor once.
        let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
            // SAFETY: live descriptors.
            check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
        }
        resize_fd(master.as_raw_fd(), spec.rows, spec.cols)?;
        let mut command = Command::new(program);
        command
            .args(&spec.argv[1..])
            .current_dir(spec.cwd)
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                for sig in [libc::SIGINT, libc::SIGQUIT, libc::SIGTSTP] {
                    libc::signal(sig, libc::SIG_DFL);
                }
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(command);
        drop(gate);
        // SAFETY: live descriptor.
        let flags = unsafe { libc::fcntl(master.as_raw_fd(), libc::F_GETFL) };
        check(flags)?;
        // SAFETY: live descriptor.
        check(unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) })?;
        Ok(Session { master, child })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Output bytes available now; `Ok(None)` when the PTY has hung up.
    pub fn read(&self, buf: &mut [u8]) -> io::Result<Option<usize>> {
        // SAFETY: a live descriptor and a writable buffer of that length.
        let n = unsafe { libc::read(self.master.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n >= 0 {
            return Ok(if n == 0 { None } else { Some(n as usize) });
        }
        let err = io::Error::last_os_error();
        match err.raw_os_error() {
            Some(libc::EAGAIN) => Ok(Some(0)),
            // Linux reports a hung-up PTY master as EIO.
            Some(libc::EIO) => Ok(None),
            _ => Err(err),
        }
    }

    pub fn write(&self, data: &[u8]) -> io::Result<usize> {
        // SAFETY: a live descriptor and a readable buffer of that length.
        let n = unsafe { libc::write(self.master.as_raw_fd(), data.as_ptr().cast(), data.len()) };
        if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
    }

    pub fn resize(&self, rows: u16, cols: u16) -> io::Result<()> {
        resize_fd(self.master.as_raw_fd(), rows, cols)
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
    }

    /// Signal the child's whole process group (it leads its own session).
    pub fn signal(&self, sig: libc::c_int) -> io::Result<()> {
        // SAFETY: plain kill(2) on the child's process group.
        check(unsafe { libc::kill(-(self.child.id() as libc::pid_t), sig) })
    }

    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(session: &mut Session) -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match session.read(&mut buf).unwrap() {
                None => break,
                Some(0) => {
                    if session.try_wait().unwrap().is_some() {
                        // The child is gone; what it wrote last may only be
                        // readable now, and is output like any other.
                        match session.read(&mut buf).unwrap() {
                            Some(n) if n > 0 => {
                                out.extend_from_slice(&buf[..n]);
                                continue;
                            }
                            _ => break,
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Some(n) => out.extend_from_slice(&buf[..n]),
            }
        }
        out
    }

    /// What the child has written once `needle` is in it (or after 10 s).
    fn read_until(session: &mut Session, needle: &str) -> String {
        let mut seen = String::new();
        let mut buf = [0u8; 1024];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !seen.contains(needle) && std::time::Instant::now() < deadline {
            if let Some(n) = session.read(&mut buf).unwrap() {
                seen.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        seen
    }

    #[test]
    fn a_child_gets_the_pty_as_its_controlling_terminal_and_size() {
        // The child waits for a line after printing, so what it printed is
        // read while it is alive and its exit is this test's to ask for.
        let argv: Vec<String> =
            ["/bin/sh", "-c", "stty size; tty -s && echo has-tty; echo \"$NAVIDE_T\"; read done"].map(String::from).to_vec();
        let env = vec![("NAVIDE_T".to_owned(), "env-ok".to_owned()), ("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        let mut session = Session::spawn(&Spawn { argv: &argv, cwd: std::path::Path::new("/"), env: &env, rows: 33, cols: 101 }).unwrap();
        let text = read_until(&mut session, "env-ok");
        // Said with the child's fate: it has been seen killed before it wrote.
        assert!(text.contains("33 101"), "{text:?}; the child: {:?}", session.try_wait());
        assert!(text.contains("has-tty"), "{text:?}");
        assert!(text.contains("env-ok"), "{text:?}");
        session.write(b"\n").unwrap();
        drain(&mut session);
        assert!(session.wait().unwrap().success());
    }

    #[test]
    fn input_reaches_the_child_and_an_interrupt_byte_stops_it() {
        let argv: Vec<String> = ["/bin/sh", "-c", "read line; echo got:$line; sleep 30"].map(String::from).to_vec();
        let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        let mut session = Session::spawn(&Spawn { argv: &argv, cwd: std::path::Path::new("/"), env: &env, rows: 24, cols: 80 }).unwrap();
        session.write(b"hello\n").unwrap();
        let seen = read_until(&mut session, "got:hello");
        assert!(seen.contains("got:hello"), "{seen:?}");
        session.write(b"\x03").unwrap();
        // Keep reading while the child exits: macOS holds an exiting session
        // leader until its terminal's unread output (the echoed ^C) is drained.
        drain(&mut session);
        let status = session.wait().unwrap();
        assert!(!status.success(), "Ctrl-C through the PTY's line discipline ends the foreground group");
    }
}

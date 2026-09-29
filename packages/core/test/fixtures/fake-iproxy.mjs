#!/usr/bin/env node
// Stand-in for the real `iproxy` binary (libimobiledevice) — binds the
// requested local port and holds it open like a real USB tunnel would, so
// run_ios_ssh_command's wrapper logic (wait-for-bind, ssh execution,
// teardown) can be exercised for real without actual iOS hardware. See
// fake-adb.mjs for why a real subprocess fake is used here instead of
// mocking spawn.
import net from "node:net";

const [, , localPortArg, , udid] = process.argv;
const localPort = Number(localPortArg);

const server = net.createServer((socket) => {
  // A UDID containing "refused" simulates the device's own SSH port not
  // actually listening — a real iproxy accepts the local TCP connection,
  // forwards it to the device, gets refused there, and closes it right
  // back, rather than hanging.
  if (udid?.includes("refused")) {
    socket.destroy();
  }
});

server.on("error", (err) => {
  console.error(`fake-iproxy: ${err.message}`);
  process.exit(1);
});

server.listen(localPort, "127.0.0.1");
// Held open until killed (SIGKILL/SIGTERM) — same lifecycle as a real
// iproxy tunnel process spawned detached by run_ios_ssh_command.

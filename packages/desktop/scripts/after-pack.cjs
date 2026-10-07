// electron-builder hook, run once the app folder is assembled and before it is signed or turned into an installer.
// Copies the server's native packages (build/server/node_modules, made by bundle-server.mjs) next to the bundled
// server inside the app's resources: electron-builder itself never copies a node_modules folder into resources.
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(__dirname, "..", "build", "server", "node_modules");
  if (!existsSync(source)) throw new Error(`${source} is missing: run \`npm run bundle -w @finanfa/desktop\` first.`);
  const resources =
    context.packager.platform.name === "mac"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  cpSync(source, path.join(resources, "server", "node_modules"), { recursive: true, dereference: true });
  console.log(`  • server native packages copied to ${path.relative(process.cwd(), path.join(resources, "server", "node_modules"))}`);
};

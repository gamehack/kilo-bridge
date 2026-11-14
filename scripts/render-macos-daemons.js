// Render plists as the unprivileged Mac user. Never run this with sudo.
import { mkdirSync, writeFileSync } from "node:fs";
import { renderDaemonPlists } from "../src/macos-launchd.js";
import path from "node:path";

const [outDir,nodeBin,kiloBin,home,repo,group,logDir]=process.argv.slice(2);
if (![outDir,nodeBin,kiloBin,home,repo,group,logDir].every(Boolean))
  throw Error("Usage: node render-macos-daemons.js OUT NODE KILO HOME REPO GROUP LOGDIR");
if (process.getuid?.()===0) throw Error("Render plists as the unprivileged user");
mkdirSync(outDir,{recursive:true,mode:0o700});
const plists=renderDaemonPlists({
  user:process.env.USER,group,home,repo,nodeBin,kiloBin,logDir
});
for(const [name,data] of Object.entries(plists)){
  const filename=path.join(outDir,`${name}.plist`);
  writeFileSync(filename,data,{mode:0o600,flag:"wx"});
  console.log(`Rendered ${filename}`);
}

// Pure launchd plist renderer. No credentials are embedded in service definitions.
import path from "node:path";

export const LABEL_KILO = "org.primalflow.kilo-server";
export const LABEL_BRIDGE = "org.primalflow.kilo-bridge";
export const BROKER_URL = "https://xnndeqrduxkdlwcdklbc.supabase.co/functions/v1/kilo-host-broker";

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function item(key, value) {
  if (value === true) return `  <key>${xml(key)}</key><true/>`;
  if (Number.isInteger(value)) return `  <key>${xml(key)}</key><integer>${value}</integer>`;
  if (Array.isArray(value)) return `  <key>${xml(key)}</key>\n  <array>\n${value.map(x => `    <string>${xml(x)}</string>`).join("\n")}\n  </array>`;
  if (value && typeof value === "object") {
    return `  <key>${xml(key)}</key>\n  <dict>\n${Object.entries(value).map(([k,v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}\n  </dict>`;
  }
  return `  <key>${xml(key)}</key><string>${xml(value)}</string>`;
}
function plist(fields) {
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">','<dict>',
    ...Object.entries(fields).map(([key,value]) => item(key,value)),
    '</dict>','</plist>',''].join("\n");
}
export function renderDaemonPlists({ user, group, home, repo, nodeBin, kiloBin, logDir }) {
  if (![home, repo, nodeBin, kiloBin, logDir].every(p => typeof p === "string" && path.isAbsolute(p) && !p.includes("\0")))
    throw new Error("All daemon filesystem paths must be absolute and nonempty");
  if (!/^[a-z][a-z0-9_-]*$/.test(user) || !/^[a-z][a-z0-9_-]*$/.test(group))
    throw new Error("Invalid daemon user/group");
  if (user !== "gamehack" || home !== "/Users/gamehack" ||
      repo !== "/Users/gamehack/kilo-workspaces/kilo-bridge")
    throw new Error("MacBook services are pinned to the approved test machine and workspace");
  const env = {
    HOME:home, USER:user, LOGNAME:user, SHELL:"/bin/zsh",
    PATH:[path.dirname(nodeBin),path.dirname(kiloBin),"/usr/local/bin","/usr/bin","/bin","/usr/sbin","/sbin"].join(":"),
    XDG_CONFIG_HOME:path.join(home,".config"),
    XDG_DATA_HOME:path.join(home,".local/share"),
    XDG_CACHE_HOME:path.join(home,".cache")
  };
  const base = {
    UserName:user, GroupName:group, RunAtLoad:true, KeepAlive:true,
    ThrottleInterval:20, Umask:63, WorkingDirectory:repo,
    EnvironmentVariables:env
  };
  return {
    [LABEL_KILO]:plist({
      Label:LABEL_KILO, ...base,
      ProgramArguments:[kiloBin,"serve","--hostname","127.0.0.1","--port","4096"],
      StandardOutPath:path.join(logDir,"kilo-server.stdout.log"),
      StandardErrorPath:path.join(logDir,"kilo-server.stderr.log")
    }),
    [LABEL_BRIDGE]:plist({
      Label:LABEL_BRIDGE, ...base,
      ProgramArguments:[nodeBin,path.join(repo,"scripts/macbook-worker.js"),"service",BROKER_URL],
      StandardOutPath:path.join(logDir,"kilo-bridge.stdout.log"),
      StandardErrorPath:path.join(logDir,"kilo-bridge.stderr.log")
    })
  };
}

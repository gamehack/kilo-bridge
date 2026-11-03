import { Bridge } from "./bridge.js";
import { KiloClient } from "./kilo-client.js";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";
import { createLogger } from "./log.js";
import { errorObject } from "./commands.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bridge = new Bridge(config, createStore(config, logger), new KiloClient(config), logger);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info("process.signal", { signal });
    void bridge.stop().then(() => { process.exitCode = 0; }).catch((error) => {
      logger.error("bridge.stop_failed", { error: errorObject(error) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  await bridge.start();
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ level: "fatal", event: "startup_failed", error: errorObject(error) }) + "\n");
  process.exitCode = 1;
});

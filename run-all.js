import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

// Needed for ES modules (__dirname replacement)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const scripts = [
  "cbinsights.js",
  "yahoo_finance.js",
  "forgeglobal.js",
];

function runScript(script) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, script);

    console.log("\n=======================================");
    console.log(`🚀 Running ${script}`);
    console.log("=======================================\n");

    const child = spawn("node", [scriptPath], {
      stdio: "inherit",
      shell: false, // ❗ IMPORTANT (do NOT use shell:true)
    });

    // If process fails to start
    child.on("error", (err) => {
      console.error(`❌ Failed to start ${script}`, err);
      reject(err);
    });

    // When process exits
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✅ ${script} completed successfully\n`);
        resolve();
      } else {
        console.error(`\n❌ ${script} exited with code ${code}\n`);
        reject(new Error(`${script} failed`));
      }
    });
  });
}

async function runAll() {
  try {
    for (const script of scripts) {
      await runScript(script);
    }

    console.log("\n🎉 ALL SCRIPTS EXECUTED SUCCESSFULLY 🎉\n");
    process.exit(0);
  } catch (err) {
    console.error("\n🛑 EXECUTION STOPPED 🛑");
    console.error(err.message);
    process.exit(1);
  }
}

runAll();
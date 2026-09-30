import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
try {
  await writeFile(new URL("../.env", import.meta.url),
    template.replace("change-me-to-a-long-random-string", randomBytes(32).toString("hex")),
    { flag: "wx", mode: 0o600 });
  console.log("Created .env with a random encryption secret. Run npm run dev to start.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".env already exists; existing settings and encryption secret were preserved.");
}

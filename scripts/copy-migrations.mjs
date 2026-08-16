import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const destination = resolve("dist/platform/migrations");
await mkdir(dirname(destination), { recursive: true });
await cp(resolve("src/platform/migrations"), destination, { recursive: true });

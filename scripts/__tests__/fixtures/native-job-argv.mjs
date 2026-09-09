import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));

import { main } from "./index.js";

main(process.argv.slice(2), {
  log: (l) => process.stdout.write(`${l}\n`),
  error: (l) => process.stderr.write(`${l}\n`),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Pas de stack trace brute pour l'utilisateur (OWASP A10) ; DEBUG pour le détail.
    process.stderr.write(`llm-crashtest : ${(err as Error)?.message ?? String(err)}\n`);
    if (process.env["DEBUG"]) process.stderr.write(`${(err as Error)?.stack ?? ""}\n`);
    process.exitCode = 1;
  },
);

import { parseArgs } from "node:util";
import { type Io, prune, rerecord, stale } from "./maintenance.js";
import { report } from "./report.js";

const HELP = `llm-crashtest : entretien des cassettes LLM

Usage :
  llm-crashtest prune    [--dir <dossier>] [--yes]       Cassettes non lues au dernier run (supprimées avec --yes)
  llm-crashtest stale    [--dir <dossier>] [--check]     Cassettes dont une requête ne correspond plus
  llm-crashtest rerecord --stale [--dir <dossier>] [-- <commande de test>]
                                                         Supprime les cassettes périmées et relance les tests en mode auto
  llm-crashtest report   --base <ref git> [--dir <dossier>] [--output <fichier>]
                                                         Résumé Markdown des cassettes modifiées (commentaire de PR)

Options :
  --dir      Dossier des cassettes (défaut : tests/__cassettes__)
  --check    stale : code de sortie 1 s'il existe des cassettes périmées (CI)
  -h, --help Affiche cette aide

prune et stale lisent la trace du dernier run, écrite par le plugin Vitest ou le helper Jest.`;

export async function main(argv: string[], io: Io, cwd = process.cwd()): Promise<number> {
  const ctx = { io, cwd };
  const sep = argv.indexOf("--");
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const command = sep === -1 ? [] : argv.slice(sep + 1);

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(own);
  } catch (err) {
    io.error((err as Error).message);
    io.error("\nVoir : llm-crashtest --help");
    return 2;
  }
  const { values, positionals } = parsed;
  const [sub] = positionals;
  if (values.help || !sub) {
    io.log(HELP);
    return sub || values.help ? 0 : 2;
  }
  const dir = values.dir ?? "tests/__cassettes__";

  switch (sub) {
    case "prune":
      return prune(dir, { yes: values.yes === true && values["dry-run"] !== true }, ctx);
    case "stale":
      return stale(dir, { check: values.check === true }, ctx);
    case "rerecord":
      if (!values.stale) {
        io.error("rerecord exige --stale (seules les cassettes périmées sont ré-enregistrées).");
        return 2;
      }
      return rerecord(dir, command, ctx);
    case "report":
      if (!values.base) {
        io.error("report exige --base <ref git>, ex. --base origin/main");
        return 2;
      }
      return report(dir, { base: values.base, output: values.output }, ctx);
    default:
      io.error(`Commande inconnue : ${sub}\n`);
      io.log(HELP);
      return 2;
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      dir: { type: "string" },
      yes: { type: "boolean" },
      "dry-run": { type: "boolean" },
      check: { type: "boolean" },
      stale: { type: "boolean" },
      base: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

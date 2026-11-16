/** Base de toutes les erreurs levées par llm-crashtest. */
export class CassetteError extends Error {
  override name = "CassetteError";
}

/** Option invalide passée à `cassetteFetch` ou variable d'environnement invalide. */
export class CassetteConfigError extends CassetteError {
  override name = "CassetteConfigError";
}

/** Fichier de cassette illisible, trop gros ou au format inattendu. */
export class CassetteFormatError extends CassetteError {
  override name = "CassetteFormatError";
}

/** En mode `replay`, aucune interaction enregistrée ne correspond à la requête. */
export class CassetteMissError extends CassetteError {
  override name = "CassetteMissError";
}

/**
 * Un motif de secret a été détecté dans une interaction : rien n'a été écrit sur disque.
 * Le message indique l'emplacement et le type de secret, jamais sa valeur.
 */
export class SecretDetectedError extends CassetteError {
  override name = "SecretDetectedError";
  constructor(
    message: string,
    readonly findings: ReadonlyArray<{ location: string; detector: string }>,
  ) {
    super(message);
  }
}

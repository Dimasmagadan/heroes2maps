// A recoverable generation failure: the whole attempt is retried with a derived seed (see generate()).
export class GenerationError extends Error {}

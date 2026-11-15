export declare const PROVIDERS: Record<string, { secrets: string[]; variables: string[] }>
export declare function resolveSigning(env: Record<string, string | undefined>): { enabled: false } | { enabled: true; provider: string }
export declare function codeSignToolArgs(jar: string, file: string, env: Record<string, string | undefined>): string[]
export declare function redact(text: string, env: Record<string, string | undefined>, names?: string[]): string
export declare function commonName(subject: string | undefined | null): string | null
export declare function signatureProblems(results: Array<{ Path: string; Status: string; Subject: string }>, publisherName: string): string[]
export declare function filesToVerify(dir: string): string[]
export declare function readSignatures(files: string[]): Array<{ Path: string; Status: string; Subject: string }>

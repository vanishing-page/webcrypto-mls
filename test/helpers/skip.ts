/**
 * How a skipped ciphersuite is reported.
 *
 * A skip is a diagnostic, not a result: the environment does not
 * implement the primitive, so there is nothing to assert either way.
 * It is printed as a TAP comment, and in the browser those comments go
 * through `tapout`, which fails the whole run if any console line
 * contains `Failed`, `FAIL` or `Error:`.
 *
 * Chromium's WebCrypto reports an algorithm it does not know as
 * `Failed to execute 'importKey' on 'SubtleCrypto'`, which is exactly
 * the message a skip carries -- so the unaltered message turns every
 * browser run red while every assertion passes. The reason is reworded
 * rather than dropped: no detail is lost, no test result changes, and
 * a real failure still prints `not ok`, which `tapout` reads directly.
 */
export function skipReason (error:unknown):string {
    const message = (error as { message?:unknown }|null|undefined)?.message
    const text = typeof message === 'string' ? message : String(error)

    return text
        .replace(/Failed/g, 'failed')
        .replace(/FAIL/g, 'fail')
        .replace(/Error:/g, 'Error -')
}

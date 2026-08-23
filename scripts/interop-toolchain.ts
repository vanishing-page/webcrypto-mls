// What the interop harness should do when the Swift toolchain is not
// installed. On a developer machine the answer is to skip: most work on
// this repo does not touch the SEAL wire format and nobody should need
// Swift to run the tests. In CI the same skip is a false negative -- the
// interop job is the only thing that checks us against another
// implementation, and a green tick for a run that did nothing is worse
// than no job at all.
//
// The decision lives here, apart from the harness, because importing
// `interop-seal.ts` compiles the Swift CLI as a side effect. Splitting
// it out is what makes it testable at all. Keep this module free of
// node imports: `tsconfig.json` narrows `types` to vite's, so a
// `node:child_process` import here fails the typecheck the moment a
// test pulls the module in. The toolchain lookup itself lives in
// interop-seal.ts, which is typechecked under `tsconfig.scripts.json`
// instead -- that project is where node's types are visible.

export interface ToolchainOutcome {
    action:'run'|'skip'|'fail';
    message:string;
    exitCode:number;
}

/**
 * Decide whether to run the interop harness, skip it, or fail the build.
 *
 * @param swiftFound Whether the Swift toolchain resolved on PATH.
 * @param ci The value of the CI environment variable, or undefined when
 * it is not set. The empty string counts as unset, matching how a
 * truthiness check on `process.env.CI` reads `CI=`.
 * @returns The action to take, the line to print, and the exit code.
 */
export function toolchainOutcome (
    swiftFound:boolean,
    ci:string|undefined
):ToolchainOutcome {
    if (swiftFound) return { action: 'run', message: '', exitCode: 0 }

    const onCi = ci !== undefined && ci !== ''
    if (onCi) {
        return {
            action: 'fail',
            message: 'FAIL: swift toolchain not found. CI is set, so the ' +
                'interop run is required: install swift on this runner ' +
                'rather than letting the job pass without comparing ' +
                'against swift-raae.',
            exitCode: 1,
        }
    }

    return {
        action: 'skip',
        message: 'SKIP: swift toolchain not found, so the interop run was ' +
            'skipped. Set CI=1 to turn this into a failure.',
        exitCode: 0,
    }
}

// Times createCommit, processMessage and joinGroup at several group
// sizes, through the package's public API only. Adapted from upstream
// ts-mls `bench/index.ts`. Run with `npm run bench`; it prints a table
// per group size and is not part of `npm test` or CI.
import { Bench } from 'tinybench'
import {
    type ClientState,
    type Proposal,
    createCommit,
    createGroup,
    defaultCapabilities,
    defaultLifetime,
    emptyPskIndex,
    generateKeyPackage,
    getCipherSuite,
    getCiphersuiteFromName,
    joinGroup,
    processMessage,
    acceptAll,
} from '../src/index.js'
import { testClientConfig } from '../test/helpers/client-config.js'

type CiphersuiteImpl = Awaited<ReturnType<typeof getCipherSuite>>
type CommitMessage = Awaited<ReturnType<typeof createCommit>>['commit']

const SIZES = [64, 256, 1024]
const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'
const ITERATIONS = 5

function member (name:string, impl:CiphersuiteImpl) {
    return generateKeyPackage(
        {
            credentialType: 'basic',
            identity: new TextEncoder().encode(name),
        },
        defaultCapabilities(),
        defaultLifetime(),
        [],
        impl,
    )
}

function framed (m:CommitMessage) {
    if (m.wireformat !== 'mls_private_message' &&
        m.wireformat !== 'mls_public_message') {
        throw new Error('expected a framed message')
    }
    return m
}

/**
 * A group of `size` members, built by alice adding everyone else in one
 * commit. Returns alice's state, the state of bob (leaf 1), and the
 * Welcome and keys a joiner needs to join that same epoch.
 */
async function buildGroup (size:number, impl:CiphersuiteImpl) {
    const alice = await member('alice', impl)
    const created = await createGroup(
        new TextEncoder().encode(`bench-${size}`),
        alice.publicPackage,
        alice.privatePackage,
        [],
        impl,
        testClientConfig,
    )

    const others = await Promise.all(
        Array.from({ length: size - 1 }, (_, i) => member(`m-${i}`, impl))
    )
    const adds:Proposal[] = others.map(kp => ({
        proposalType: 'add',
        add: { keyPackage: kp.publicPackage },
    }))
    const added = await createCommit(
        { state: created, cipherSuite: impl },
        { extraProposals: adds, ratchetTreeExtension: true },
    )
    if (!added.welcome) throw new Error('expected a Welcome')

    const bobKeys = others[0]
    const bob = await joinGroup(
        added.welcome,
        bobKeys.publicPackage,
        bobKeys.privatePackage,
        emptyPskIndex,
        impl,
        undefined,
        undefined,
        testClientConfig,
    )

    return {
        alice: added.newState,
        bob,
        welcome: added.welcome,
        joiner: others[others.length - 1],
    }
}

async function benchSize (size:number, impl:CiphersuiteImpl) {
    const group = await buildGroup(size, impl)
    const alice:ClientState = group.alice
    // One commit for processMessage to receive repeatedly. States are
    // values, so processing it from the same `bob` each time is the
    // same work every iteration.
    const { commit } = await createCommit({ state: alice, cipherSuite: impl })
    const message = framed(commit)
    const { publicPackage, privatePackage } = group.joiner

    const bench = new Bench({
        name: `${size} members`,
        iterations: ITERATIONS,
        time: 0,
        warmupIterations: 1,
        warmupTime: 0,
    })

    bench.add('createCommit', async () => {
        await createCommit({ state: alice, cipherSuite: impl })
    })
    bench.add('processMessage', async () => {
        const result = await processMessage(
            message,
            group.bob,
            emptyPskIndex,
            acceptAll,
            impl,
        )
        if (result.kind !== 'newState') {
            throw new Error('expected a new state')
        }
    })
    bench.add('joinGroup', async () => {
        // joinGroup zeroizes the init key in place, so each join gets
        // its own copy.
        await joinGroup(
            group.welcome,
            publicPackage,
            {
                ...privatePackage,
                initPrivateKey: privatePackage.initPrivateKey.slice(),
            },
            emptyPskIndex,
            impl,
            undefined,
            undefined,
            testClientConfig,
        )
    })

    await bench.run()
    for (const task of bench.tasks) {
        if (task.result.state === 'errored') throw task.result.error
    }
    console.log(bench.name)
    console.table(bench.table())
}

const impl = await getCipherSuite(getCiphersuiteFromName(SUITE))
console.log(`${SUITE}, ${ITERATIONS} iterations per task`)
for (const size of SIZES) await benchSize(size, impl)

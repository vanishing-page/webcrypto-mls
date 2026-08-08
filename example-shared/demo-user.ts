import type {
    KeyPackage,
    ClientState,
    PrivateKeyPackage
} from '../src/index.js'

/**
 * One MLS client as the demos model it. The existing demos hold a map
 * of many of these; the realistic demo holds exactly one.
 */
export interface DemoUser {
    name:string
    state?:ClientState
    keyPackage?:KeyPackage
    privateKeys?:PrivateKeyPackage
}

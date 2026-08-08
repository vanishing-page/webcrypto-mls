/**
 * True when `href` (a pathname, optionally with a query string) points at
 * the client-side-routed persistence demo page under `<basePath>/persistence`,
 * so the caller can decide which demo component to render.
 */
export function isPersistencePath (href:string, basePath:string):boolean {
    const pathname = href.split('?')[0]
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
    const persistencePath = `${base}/persistence`

    return pathname === persistencePath ||
        pathname.startsWith(`${persistencePath}/`)
}

/**
 * True when `href` (a pathname, optionally with a query string) points at
 * the client-side-routed multi-device demo page under
 * `<basePath>/multi-device`, so the caller can decide which demo component
 * to render.
 */
export function isMultiDevicePath (href:string, basePath:string):boolean {
    const pathname = href.split('?')[0]
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
    const multiDevicePath = `${base}/multi-device`

    return pathname === multiDevicePath ||
        pathname.startsWith(`${multiDevicePath}/`)
}

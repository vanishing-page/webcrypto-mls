import { type FunctionComponent } from 'preact'
import { html } from 'htm/preact'
import { isPersistencePath, isMultiDevicePath } from './routing.js'

export interface NavItem {
    label:string
    href:string
    active:boolean
}

/**
 * Pure link-model for the shared nav, kept separate from the rendering
 * component so it can be unit-tested via a runtime import in the Node test
 * bundle (mirrors example/routing.ts's path-predicate split).
 */
export function navItems (route:string, basePath:string):NavItem[] {
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
    const isPersistence = isPersistencePath(route, basePath)
    const isMultiDevice = isMultiDevicePath(route, basePath)

    return [
        {
            label: 'Main demo',
            href: `${base}/`,
            active: !isPersistence && !isMultiDevice
        },
        {
            label: 'Persistence',
            href: `${base}/persistence`,
            active: isPersistence
        },
        {
            label: 'Multi-device',
            href: `${base}/multi-device`,
            active: isMultiDevice
        }
    ]
}

export const Nav:FunctionComponent<{ route:string; basePath:string }> =
    function ({ route, basePath }) {
        const items = navItems(route, basePath)

        return html`
        <nav class="site-nav">
            <ul>
                ${items.map((item) => html`
                    <li key=${item.label}>
                        <a
                            href=${item.href}
                            class=${item.active ? 'active' : ''}
                        >
                            ${item.label}
                        </a>
                    </li>
                `)}
            </ul>
        </nav>
    `
    }

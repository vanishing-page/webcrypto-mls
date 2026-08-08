import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'
// `svg` is `html` under the hood (htm/preact only exports `html`, and
// Preact picks the SVG namespace from the rendered tree, not the tag).
// Tagging SVG-returning templates `svg` makes the lit-html editor
// extension apply its SVG grammar so the markup highlights correctly.
const svg = html
import type {
    TreeViewLayout,
    TreeViewEdge,
    PositionedTreeNode,
    SelectedNodeDetails,
} from './tree-view.js'
import { CardHeader } from '../example-shared/card-header.js'
import { NBSP } from '../example-shared/constants.js'

export type TreeDiagramDetail =
    | { kind:'peek'; count:number }
    | { kind:'node'; details:SelectedNodeDetails }
    | { kind:'none' }

function treeEdgeView (edge:TreeViewEdge, i:number, onPath:boolean) {
    return svg`<line
        key=${i}
        x1=${edge.x1}
        y1=${edge.y1}
        x2=${edge.x2}
        y2=${edge.y2}
        class="tree-edge ${onPath ? 'on-path' : ''}"
    />`
}

function treeNodeLabel (node:PositionedTreeNode, label:string|undefined) {
    if (node.kind === 'leaf') {
        return svg`<text
            class="leaf-label"
            x=${node.x}
            y=${node.y + 28}
            text-anchor="middle"
        >
            ${label}
        </text>`
    }

    return svg`
        <text
            class="node-index"
            x=${node.x}
            y=${node.y}
            text-anchor="middle"
            dominant-baseline="central"
        >
            ${node.nodeIndex}
        </text>
    `
}

function treeNodeView (
    node:PositionedTreeNode,
    onPath:boolean,
    selected:boolean,
    onSelect:() => void,
    leafLabels:LeafLabelOptions
) {
    // A leaf's label and its accessible name are the same description,
    // so a screen reader is told exactly what a hover reveals.
    const label = node.name === undefined ?
        undefined :
        (leafLabels.describe ? leafLabels.describe(node.name) : node.name)

    const hideLabel = node.kind === 'leaf' && !!leafLabels.reveal

    return svg`
        <g
            key=${node.nodeIndex}
            class="tree-node ${node.kind} ${
                onPath ? 'on-path' : ''} ${
                selected ? 'selected' : ''} ${
                hideLabel ? 'hide-label' : ''} selectable"
            role="button"
            tabindex="0"
            aria-label=${label === undefined ?
                `${node.kind} node ${node.nodeIndex}` :
                `${node.kind} node ${node.nodeIndex}: ${label}`}
            onClick=${onSelect}
            onKeyDown=${(ev:KeyboardEvent) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    onSelect()
                }
            }}
        >
            <circle
                class="hit"
                cx=${node.x}
                cy=${node.y}
                r="22"
                pointer-events="all"
            />
            <circle cx=${node.x} cy=${node.y} r="14" />
            ${treeNodeLabel(node, label)}
        </g>
    `
}

export interface LeafLabelOptions {
    /**
     * Hide leaf labels until the leaf is hovered or focused. Defaults to
     * false: every label is drawn at once, which is what a small group
     * wants. A tree with tens of leaves cannot show them all without the
     * labels colliding, so it opts in to revealing one at a time.
     */
    reveal?:boolean;

    /**
     * Turn a leaf's name into the text shown for it, both as the label
     * and as the leaf's accessible name. Defaults to the name itself.
     * A revealed label has the whole width of the diagram to itself, so
     * a caller whose names are terse ids can spell them out here.
     */
    describe?:(name:string) => string;
}

export interface TreeDiagramProps {
    layout:TreeViewLayout;
    hoveredPath:Set<number>;
    selectedNodeIndex:number | null;
    onSelectNode:(nodeIndex:number) => void;
    onClear:() => void;
    leafLabels?:LeafLabelOptions;

    /**
     * Extra nodes drawn with the same outline as the pinned node, without
     * pinning anything. A page whose selection is one person rather than
     * one node passes every leaf that person holds, so all their devices
     * are outlined at once. Defaults to none.
     */
    outlinedNodes?:Set<number>;
}

/**
 * Shared Ratchet Tree SVG diagram: renders edges, nodes, and node labels
 * from a `TreeViewLayout`, with on-path highlighting driven by
 * `hoveredPath` and a pinned node driven by `selectedNodeIndex`. Each
 * consumer owns its own hover/selection signals and passes them in, plus
 * `onSelectNode` to react to a click/keyboard-activate on a node, and
 * `onClear` for the header button that unpins the selected node.
 */
export const TreeDiagram:FunctionComponent<TreeDiagramProps> = function ({
    layout,
    hoveredPath,
    selectedNodeIndex,
    onSelectNode,
    onClear,
    leafLabels = {},
    outlinedNodes
}) {
    // Margin around the diagram. A revealed label is a whole sentence
    // centred on its leaf, so the outermost leaves need more room than
    // the always-visible case, which an SVG would otherwise clip.
    const pad = leafLabels.reveal ? 90 : 30

    return html`
        <div class="card tree-diagram">
            <${CardHeader}
                title="Ratchet Tree"
                showClear=${selectedNodeIndex !== null}
                onClear=${onClear}
            />
            <!-- The diagram scrolls, the header does not, so the card
                 keeps its title however wide the tree gets. -->
            <div class="tree-svg-scroll">
                <svg class="tree-svg"
                    width=${layout.width + pad * 2}
                    height=${layout.height + pad + 30}
                    viewBox=${`${-pad} -30 ${layout.width + pad * 2} ` +
                        `${layout.height + pad + 30}`}
                >
                    ${layout.edges.map((edge, i) => {
                        const onPath = hoveredPath.has(edge.parentIndex) &&
                            hoveredPath.has(edge.childIndex)
                        return treeEdgeView(edge, i, onPath)
                    })}
                    ${layout.nodes.map((node) => {
                        const onPath = hoveredPath.has(node.nodeIndex)
                        const selected = selectedNodeIndex === node.nodeIndex ||
                            !!outlinedNodes?.has(node.nodeIndex)
                        return treeNodeView(node, onPath, selected, () => {
                            onSelectNode(node.nodeIndex)
                        }, leafLabels)
                    })}
                </svg>
            </div>
        </div>
    `
}

export interface TreeNodeDetailPanelProps {
    detail:TreeDiagramDetail;
}

/**
 * Shared node-detail panel: shows the key-change count while a member is
 * hovered/peeked, or a pinned node's kind/public key/JSON (plus the
 * root-note explainer) once a tree node has been clicked. Renders nothing
 * when there is nothing to show.
 */
export const TreeNodeDetailPanel:FunctionComponent<
    TreeNodeDetailPanelProps
> = function ({ detail }) {
    if (detail.kind === 'peek') {
        return html`
            <div class="detail peek">
                <p>
                    Rotating keys would change${NBSP}
                    ${detail.count}${NBSP}
                    ${detail.count === 1 ? 'key' : 'keys'}.
                </p>
            </div>
        `
    }

    if (detail.kind === 'node') {
        return html`
            <div class="detail node">
                <h4>Node ${detail.details.nodeIndex}</h4>
                <p>Kind:${NBSP}${detail.details.kind}</p>
                ${detail.details.publicKeyBase64 ? html`
                    <p class="pubkey">
                        Public key:${NBSP}
                        ${detail.details.publicKeyBase64}
                    </p>
                ` : html`
                    <p>No key material.</p>
                `}
                ${detail.details.nodeJson ? html`
                    <div class="node-json">
                        <p class="node-json-label">
                            All properties:
                        </p>
                        <pre>${detail.details.nodeJson}</pre>
                    </div>
                ` : null}
                ${detail.details.isRoot ? html`
                    <p class="root-note">
                        This is the root node. Its secret is shared by
                        every member of the group. In each epoch,
                        the root's key seeds the <a href="https://github.com/vanishing-page/webcrypto-mls#key-schedule">
                        key schedule</a>, which derives the group's
                        secret epoch keys and, from them, the epoch
                        authenticator shown above. The <a href="https://github.com/vanishing-page/webcrypto-mls#epoch-authenticator">
                        epoch authenticator</a> is a public value
                        members can compare to confirm they share
                        the same epoch state.
                    </p>

                    <p>
                        <a href="https://github.com/vanishing-page/webcrypto-mls#"></a>
                        Each group member derives the root secret
                        independently.
                    </p>
                ` : null}
            </div>
        `
    }

    return null
}

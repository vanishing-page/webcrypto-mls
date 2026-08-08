import type { FunctionComponent } from 'preact'
import { html } from 'htm/preact'

export interface CardHeaderProps {
    /**
     * The heading text for the card, eg 'Ratchet Tree'.
     */
    title:string;

    /**
     * Whether there is a selection to clear. The Clear button only
     * exists while something is selected.
     */
    showClear:boolean;

    onClear:() => void;
}

/**
 * The header shell shared by the cards that swap their body out from
 * under a fixed heading: a title plus the Clear button that drops the
 * current selection. Callers own what "clear" means and pass in the
 * title, so one card can present several bodies without duplicating
 * this markup.
 */
export const CardHeader:FunctionComponent<CardHeaderProps> = function ({
    title,
    showClear,
    onClear
}) {
    return html`
        <div class="tree-header">
            <h3>${title}</h3>
            ${showClear ? html`
                <button
                    class="clear"
                    aria-label="Clear selection"
                    onClick=${onClear}
                >
                    Clear
                </button>
            ` : null}
        </div>
    `
}

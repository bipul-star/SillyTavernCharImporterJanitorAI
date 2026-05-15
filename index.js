/**
 * ============================================================
 * JanitorAI Character Importer — Frontend Extension (index.js)
 * ============================================================
 * Version 2.0 — Pure Frontend (No Server Plugin)
 *
 * ARCHITECTURE:
 *   Because JanitorAI uses Cloudflare Enterprise protection, automated
 *   fetch() calls from a server plugin are blocked. This extension
 *   instead asks the user to manually copy the page source (Ctrl+U)
 *   and paste it into a textarea. All extraction, mapping, and import
 *   logic runs entirely in the browser.
 *
 * FLOW:
 *   1. User pastes raw HTML source from a JanitorAI character page.
 *   2. Extension extracts character data from the HTML string using
 *      regex (window.mbxM hydration pattern) or __NEXT_DATA__ fallback.
 *   3. Extracted data is mapped to the SillyTavern V2 Character Card spec.
 *   4. The V2 JSON is turned into a File/Blob and uploaded to ST's
 *      internal /api/characters/import endpoint via $.ajax (which
 *      automatically attaches CSRF tokens).
 *   5. Character list is refreshed and a toast notification is shown.
 *
 * INSTALLATION:
 *   Place this folder in:
 *     <SillyTavern>/public/scripts/extensions/third-party/ST-JanitorAI-Importer/
 */

// ─── Extension Identity ──────────────────────────────────────
const extensionName       = 'ST-JanitorAI-Importer';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ─── Status Helpers ──────────────────────────────────────────

/**
 * Display a status message in the settings panel.
 * @param {'loading' | 'success' | 'error'} type  Visual style
 * @param {string} message  HTML-safe message text
 */
function setStatus(type, message) {
    const $area = $('#janitor_status_area');
    const $text = $('#janitor_status_text');

    $area.removeClass('status-loading status-success status-error')
         .addClass(`status-${type}`)
         .show();

    const icons = {
        loading: '<span class="janitor-spinner"></span>',
        success: '<i class="fa-solid fa-check-circle"></i> ',
        error:   '<i class="fa-solid fa-triangle-exclamation"></i> ',
    };

    $text.html(`${icons[type] || ''}${message}`);
}

/** Hide the status area entirely. */
function clearStatus() {
    $('#janitor_status_area')
        .hide()
        .removeClass('status-loading status-success status-error');
    $('#janitor_status_text').html('');
}

// ─── String Utilities ────────────────────────────────────────

/**
 * Unescapes a JavaScript string literal captured from inside quotes.
 * Handles: \" \\ \/ \b \f \n \r \t and \uXXXX sequences.
 *
 * This is necessary because the JSON inside window.mbxM.push(JSON.parse("..."))
 * is double-escaped — it's a JSON string inside a JS string literal.
 *
 * @param {string} str  The escaped string (without surrounding quotes)
 * @returns {string}    The unescaped string ready for JSON.parse()
 */
function unescapeJsString(str) {
    return str.replace(
        /\\(["\\\/bfnrt])|\\u([0-9a-fA-F]{4})/g,
        (match, simple, unicode) => {
            if (unicode) {
                return String.fromCharCode(parseInt(unicode, 16));
            }
            const map = {
                '"': '"', '\\': '\\', '/': '/',
                'b': '\b', 'f': '\f', 'n': '\n',
                'r': '\r', 't': '\t',
            };
            return map[simple] || simple;
        }
    );
}

/**
 * Strips HTML tags from a string, preserving readable text content.
 * Converts <br> and </p> to newlines before removing all other tags,
 * then decodes common HTML entities.
 *
 * Used to clean JanitorAI's `description` field (which contains HTML)
 * before mapping it to the plain-text `creator_notes` field.
 *
 * @param {string} html  Raw HTML string
 * @returns {string}     Plain text
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')       // <br> → newline
        .replace(/<\/p>/gi, '\n')             // </p> → newline
        .replace(/<[^>]+>/g, '')              // strip all remaining tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim();
}

// ─── Character Data Extraction ───────────────────────────────

/**
 * ─────────────────────────────────────────────────────────────
 * PRIMARY EXTRACTION — window.mbxM hydration pattern
 * ─────────────────────────────────────────────────────────────
 *
 * JanitorAI's Next.js frontend uses a custom hydration mechanism that
 * pushes serialized JSON into a global `window.mbxM` array:
 *
 *   <script>window.mbxM.push(JSON.parse("...escaped JSON..."))</script>
 *
 * REGEX BREAKDOWN:
 *   /window\.mbxM\.push\(JSON\.parse\("((?:[^"\\]|\\.)*)"\)\)/g
 *
 *   window\.mbxM\.push\(JSON\.parse\("   literal prefix
 *   (                                     start capture group
 *     (?:                                 non-capturing alternation:
 *       [^"\\]                              any char except " or \
 *       |                                   OR
 *       \\.                                 a backslash + any char (escape seq)
 *     )*                                  zero or more times
 *   )                                     end capture group
 *   "\)\)                                 literal suffix: "))
 *   /g                                    global flag (find ALL matches)
 *
 * We iterate all matches because the page may have multiple hydration
 * chunks. We look for the one containing the character store at key:
 *   parsedObject['Sl--a:a-a--characterStore'].character
 * ─────────────────────────────────────────────────────────────
 */
const HYDRATION_REGEX     = /window\.mbxM\.push\(JSON\.parse\("((?:[^"\\]|\\.)*)"\)\)/g;

/**
 * Extracts the JanitorAI character object from raw HTML source.
 * Tries the mbxM hydration pattern first, then falls back to __NEXT_DATA__.
 *
 * @param {string} htmlString  The full page source HTML
 * @returns {object|null}      The raw JanitorAI character object, or null
 */
function extractCharacterFromHtml(htmlString) {
    // ── Attempt 1: window.mbxM hydration blocks ──────────────
    HYDRATION_REGEX.lastIndex = 0; // reset for global regex
    let match;

    while ((match = HYDRATION_REGEX.exec(htmlString)) !== null) {
        try {
            const escaped  = match[1];
            const unescaped = unescapeJsString(escaped);
            const parsed    = JSON.parse(unescaped);

            // Check if this chunk contains the character store
            // We search for a key containing 'characterStore' to handle dynamic Next.js chunk hashes (like Sk--, Sl--)
            const storeKey = Object.keys(parsed).find(k => k.includes('characterStore'));
            if (storeKey && parsed[storeKey]) {
                const store = parsed[storeKey];
                if (store.character) {
                    console.log('[JanitorAI Importer] Found character via mbxM hydration:', store.character.chat_name || store.character.name);
                    return store.character;
                }
            }
        } catch (e) {
            // Not the chunk we want — keep iterating
            console.debug('[JanitorAI Importer] Skipping non-character hydration chunk');
        }
    }

    // ── Attempt 2: __NEXT_DATA__ script tag (fallback) ───────
    // Some JanitorAI pages may use the standard Next.js data injection
    // via <script id="__NEXT_DATA__" type="application/json">...</script>
    const nextDataMatch = htmlString.match(
        /<script\s+id="__NEXT_DATA__"\s+type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
    );

    if (nextDataMatch) {
        try {
            const nextData  = JSON.parse(nextDataMatch[1]);
            const pageProps = nextData?.props?.pageProps;

            if (pageProps?.character) {
                console.log('[JanitorAI Importer] Found character via __NEXT_DATA__:', pageProps.character.chat_name || pageProps.character.name);
                return pageProps.character;
            }
            if (pageProps?.data?.character) {
                console.log('[JanitorAI Importer] Found character via __NEXT_DATA__.data:', pageProps.data.character.chat_name || pageProps.data.character.name);
                return pageProps.data.character;
            }
        } catch (e) {
            console.warn('[JanitorAI Importer] __NEXT_DATA__ parse failed:', e.message);
        }
    }

    // ── Neither method found character data ───────────────────
    return null;
}

// ─── V2 Character Card Mapping ───────────────────────────────

/**
 * Maps a raw JanitorAI character object to the SillyTavern V2 Character Card spec.
 *
 * FIELD MAPPING TABLE:
 *   JanitorAI field       →  V2 Card field
 *   ──────────────────────────────────────────
 *   chat_name             →  name
 *   personality            →  description
 *   first_message          →  first_mes
 *   first_messages[]       →  alternate_greetings[]
 *   scenario               →  scenario
 *   example_dialogs        →  mes_example
 *   description (HTML)     →  creator_notes (plain text)
 *   (hardcoded "")         →  system_prompt
 *
 * All character traits are nested inside a `data: {}` object as per the V2 spec.
 *
 * @param {object} janitorChar  Raw JanitorAI character object
 * @returns {object}            V2 Character Card JSON
 */
function mapToV2Card(janitorChar) {
    const name         = janitorChar.chat_name || janitorChar.name || 'Unknown';
    const description  = janitorChar.personality || '';
    const firstMes     = janitorChar.first_message || '';
    const scenario     = janitorChar.scenario || '';
    const mesExample   = janitorChar.example_dialogs || '';
    const creatorNotes = janitorChar.description ? stripHtml(janitorChar.description) : '';
    const creator      = janitorChar.creator_name || janitorChar.created_by || '';

    // first_messages is an array of alternate greeting strings
    let alternateGreetings = [];
    if (Array.isArray(janitorChar.first_messages)) {
        alternateGreetings = janitorChar.first_messages
            .filter(msg => typeof msg === 'string' && msg.trim().length > 0);
    }

    // Construct the full V2 Character Card
    return {
        // ── Spec V1 compatibility fields (top-level) ─────────
        name,
        description,
        personality:    '',
        scenario,
        first_mes:      firstMes,
        mes_example:    mesExample,
        creatorcomment: creatorNotes,
        avatar:         'none',
        chat:           `${name} - ${new Date().toISOString()}`,
        talkativeness:  0.5,
        fav:            false,
        tags:           [],
        create_date:    new Date().toISOString(),

        // ── Spec V2 envelope ─────────────────────────────────
        spec:           'chara_card_v2',
        spec_version:   '2.0',

        // ── V2 data block (primary) ──────────────────────────
        data: {
            name,
            description,
            personality:                '',
            scenario,
            first_mes:                  firstMes,
            mes_example:                mesExample,
            creator_notes:              creatorNotes,
            system_prompt:              '',
            post_history_instructions:  '',
            alternate_greetings:        alternateGreetings,
            tags:                       [],
            creator,
            character_version:          '1.0',
            extensions: {
                talkativeness: 0.5,
                fav:   false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth:  4,
                    role:   'system',
                },
            },
        },
    };
}

// ─── Import Pipeline ─────────────────────────────────────────

/**
 * Full import pipeline:
 *   1. Read the pasted HTML from the textarea
 *   2. Extract character data (mbxM regex or __NEXT_DATA__ fallback)
 *   3. Map to V2 Character Card JSON
 *   4. Build a JSON File blob
 *   5. Upload to SillyTavern via $.ajax (CSRF-safe) to /api/characters/import
 *   6. Refresh character list + show toast
 */
async function handleImport() {
    const $btn   = $('#janitor_import_btn');
    const $input = $('#janitor_html_input');
    const html   = $input.val()?.toString().trim();

    // ── Guard: empty textarea ────────────────────────────────
    if (!html) {
        toastr.warning(
            'Please paste the JanitorAI page source into the text area first.',
            'Nothing to Import'
        );
        return;
    }

    // ── Guard: sanity check — does this look like HTML? ──────
    if (!html.includes('<') || !html.includes('>')) {
        toastr.error(
            'This doesn\'t look like HTML source code. Make sure you copied the <b>page source</b> (Ctrl+U), not the page content.',
            'Invalid Input'
        );
        return;
    }

    // ── Disable button during processing ─────────────────────
    $btn.addClass('disabled');
    setStatus('loading', 'Extracting character data from pasted HTML…');

    try {
        // ── Step 1: Extract character data ────────────────────
        const janitorChar = extractCharacterFromHtml(html);

        if (!janitorChar) {
            throw new Error(
                'Could not find character data in the pasted HTML. ' +
                'Make sure you copied the <b>full page source</b> from a JanitorAI character page. ' +
                'The page must be a character profile, not a search page or chat page.'
            );
        }

        const charName = janitorChar.chat_name || janitorChar.name || 'Unknown';
        setStatus('loading', `Found "<b>${charName}</b>" — mapping to V2 format…`);

        // ── Step 2: Map to V2 Character Card ──────────────────
        const v2Card = mapToV2Card(janitorChar);

        setStatus('loading', `Importing "<b>${charName}</b>" into SillyTavern…`);

        // ── Step 3: Build a JSON File for ST's import endpoint ─
        // SillyTavern's /api/characters/import expects multipart form data:
        //   - "avatar" field: the character file (JSON or PNG)
        //   - "file_type" field: "json" | "png" | "yaml" etc.
        const jsonString = JSON.stringify(v2Card, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const file = new File([blob], `${charName}.json`, { type: 'application/json' });

        const formData = new FormData();
        formData.append('avatar', file);
        formData.append('file_type', 'json');

        // ── Step 4: Upload via $.ajax ─────────────────────────
        // CRITICAL: We use jQuery $.ajax instead of fetch() because
        // SillyTavern's jQuery AJAX setup automatically attaches
        // CSRF tokens (X-CSRF-Token header) to all $.ajax requests.
        // Using fetch() would bypass this and get 403 Forbidden.
        const importResult = await new Promise((resolve, reject) => {
            $.ajax({
                url:         '/api/characters/import',
                type:        'POST',
                data:        formData,
                processData: false,   // Don't let jQuery serialize FormData
                contentType: false,   // Let the browser set multipart boundary
                success: (data) => resolve(data),
                error: (jqXHR, textStatus, errorThrown) => {
                    const msg = jqXHR.responseText || errorThrown || textStatus;
                    reject(new Error(`Import failed (${jqXHR.status}): ${msg}`));
                },
            });
        });

        // Check if ST returned an error object
        if (importResult && importResult.error) {
            throw new Error('SillyTavern rejected the character import.');
        }

        // ── Step 5: Refresh the character list ────────────────
        try {
            const context = SillyTavern.getContext();
            if (typeof context.getCharacters === 'function') {
                await context.getCharacters();
            }
        } catch (refreshErr) {
            console.warn('[JanitorAI Importer] Auto-refresh failed:', refreshErr);
        }

        // ── Step 6: Success! ──────────────────────────────────
        setStatus('success', `"<b>${charName}</b>" imported successfully!`);
        toastr.success(
            `<b>${charName}</b> has been added to your roster.`,
            'JanitorAI Import Complete',
            { timeOut: 5000 }
        );

        // Clear the textarea for the next import
        $input.val('');

    } catch (err) {
        console.error('[JanitorAI Importer] Import failed:', err);
        setStatus('error', err.message || 'An unknown error occurred.');
        toastr.error(
            err.message || 'Failed to import character.',
            'Import Failed',
            { timeOut: 8000 }
        );
    } finally {
        $btn.removeClass('disabled');
    }
}

// ─── Extension Initialization ────────────────────────────────

jQuery(async () => {
    // Load the settings panel HTML template from the extension folder
    const settingsHtml = await $.get(`${extensionFolderPath}/index.html`);

    // Append to the RIGHT column of the extensions settings panel
    // (extensions_settings2 = right column, for visual/UI-related extensions)
    $('#extensions_settings2').append(settingsHtml);

    // Bind the import button
    $('#janitor_import_btn').on('click', handleImport);

    console.log('[JanitorAI Importer] Extension loaded (v2 — pure frontend).');
});

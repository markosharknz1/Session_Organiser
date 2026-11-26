// Shared across every page: swaps the static favicon for the club's
// uploaded icon (falling back to the bundled default when none has been
// uploaded - see routes/branding.js) and shows a small logo next to the
// club name in the header. Call with whatever club-settings object the
// page already fetched (every page's init() loads one for club_name
// anyway) - no extra request needed.
// --- Name ordering, shared by every list of players -------------------------
// Lists sort by first name by default (names are shown "First Last", and
// first names are how people at the desk know each other), with surname as
// the tiebreak; the Check-in and Player Database pages offer a "surname"
// order too, remembered in this browser, and the Rounds page follows the
// same choice. Comparison ignores case and stray spaces, so " smith" sorts
// with "Smith". (The key was renamed when the default changed from
// surname, so every computer starts on first name once.)
const NAME_SORT_KEY = 'game-scheduler-name-sort-2';

function nameSortOrder() {
    try { return localStorage.getItem(NAME_SORT_KEY) === 'last' ? 'last' : 'first'; } catch (e) { return 'first'; }
}

function setNameSortOrder(order) {
    try { localStorage.setItem(NAME_SORT_KEY, order === 'first' ? 'first' : 'last'); } catch (e) { /* not remembered, still applied */ }
}

function compareNamePart(a, b) {
    return String(a || '').trim().localeCompare(String(b || '').trim(), undefined, { sensitivity: 'base' });
}

// Sorts {first_name, last_name} rows by the chosen order (default: the
// remembered one).
function comparePlayersByName(a, b, order = nameSortOrder()) {
    if (order === 'first') return compareNamePart(a.first_name, b.first_name) || compareNamePart(a.last_name, b.last_name);
    return compareNamePart(a.last_name, b.last_name) || compareNamePart(a.first_name, b.first_name);
}

// Wires a pair of "Surname / First name" buttons: marks the active one and
// re-renders via onChange when clicked.
function wireNameSortToggle(container, onChange) {
    if (!container) return;
    const refresh = () => {
        const order = nameSortOrder();
        container.querySelectorAll('button[data-sort]').forEach((b) => b.classList.toggle('active', b.dataset.sort === order));
    };
    container.querySelectorAll('button[data-sort]').forEach((b) => b.addEventListener('click', () => {
        setNameSortOrder(b.dataset.sort);
        refresh();
        onChange();
    }));
    refresh();
}

function applyBranding(clubSettings) {
    const ver = clubSettings?.club_icon_ver || 0;
    const url = `/api/branding/icon?v=${ver}`;

    const iconLink = document.querySelector('link[rel="icon"]');
    if (iconLink) iconLink.href = url;

    let logo = document.getElementById('club-logo');
    const heading = document.getElementById('club-name');
    if (!logo && heading && heading.parentNode) {
        logo = document.createElement('img');
        logo.id = 'club-logo';
        logo.alt = '';
        heading.parentNode.insertBefore(logo, heading);
    }
    if (logo) logo.src = url;
}

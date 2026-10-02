const express = require('express');
const store = require('../db/store');
const { broadcast } = require('../lib/eventBus');
const { sendEmail, parseRecipientList } = require('../lib/sendEmail');

const router = express.Router();

const DATE_FORMATS = ['DMY', 'MDY', 'YMD'];
const EMAIL_PROVIDERS = ['smtp2go', 'mailgun', 'gmail'];

// The PIN hashes and the cookie secret stay on the server. A device signed
// in with the check-in PIN also gets no credentials - the Check-in page
// only needs the club name, date format and whether payments are tracked.
const CREDENTIAL_FIELDS = ['smtp2go_api_key', 'mailgun_api_key', 'gmail_user', 'gmail_app_password', 'square_access_token', 'square_location_id', 'summary_recipient_emails'];
function publicSettings(row, role = 'admin') {
    if (!row) return row;
    const { access_pin_hash, desk_pin_hash, access_secret, ...rest } = row;
    if (role !== 'admin') for (const f of CREDENTIAL_FIELDS) delete rest[f];
    return { ...rest, access_pin_set: !!access_pin_hash, desk_pin_set: !!desk_pin_hash };
}

router.get('/', (req, res) => {
    res.json(publicSettings(store.queryOne('SELECT * FROM club_settings WHERE id = 1'), req.accessRole));
});

router.put('/', (req, res) => {
    const existing = store.queryOne('SELECT * FROM club_settings WHERE id = 1');
    const merged = { ...existing, ...req.body };
    if (!DATE_FORMATS.includes(merged.date_format)) {
        return res.status(400).json({ error: `date_format must be one of ${DATE_FORMATS.join(', ')}` });
    }
    if (!EMAIL_PROVIDERS.includes(merged.email_provider)) {
        return res.status(400).json({ error: `email_provider must be one of ${EMAIL_PROVIDERS.join(', ')}` });
    }
    try {
        store.run(
            `UPDATE club_settings SET club_name=?, default_game_minutes=?, default_break_minutes=?, max_capacity=?, square_enabled=?,
             email_provider=?,
             smtp2go_api_key=?, smtp2go_sender_email=?, smtp2go_sender_name=?,
             mailgun_api_key=?, mailgun_domain=?, mailgun_sender_email=?, mailgun_sender_name=?,
             gmail_user=?, gmail_app_password=?,
             summary_recipient_emails=?, square_access_token=?, square_location_id=?,
             gender_aware_pairing=?, date_format=?, allow_network_access=?, updated_at=datetime('now')
             WHERE id=1`,
            [merged.club_name, merged.default_game_minutes, merged.default_break_minutes, merged.max_capacity,
                merged.square_enabled ? 1 : 0,
                merged.email_provider,
                merged.smtp2go_api_key || null, merged.smtp2go_sender_email || null, merged.smtp2go_sender_name || null,
                merged.mailgun_api_key || null, merged.mailgun_domain || null, merged.mailgun_sender_email || null, merged.mailgun_sender_name || null,
                merged.gmail_user || null, merged.gmail_app_password || null,
                merged.summary_recipient_emails || null,
                merged.square_access_token || null, merged.square_location_id || null,
                merged.gender_aware_pairing ? 1 : 0, merged.date_format, merged.allow_network_access ? 1 : 0]
        );
        store.persist();
        broadcast('club_settings', {});
        res.json(publicSettings(store.queryOne('SELECT * FROM club_settings WHERE id = 1')));
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Catches a bad API key or misconfigured sender/recipients in Settings,
// before relying on it for a real end-of-night send.
router.post('/send-test-email', async (req, res) => {
    const club = store.queryOne('SELECT * FROM club_settings WHERE id = 1');
    const to = parseRecipientList(club?.summary_recipient_emails);
    if (to.length === 0) return res.status(400).json({ error: 'No recipient email addresses configured yet - add some above first.' });
    try {
        const result = await sendEmail(club, {
            to,
            subject: `${club.club_name || 'Game Scheduler'} - test email`,
            htmlBody: '<p>This is a test email from Game Scheduler\'s Club Settings page. If you got this, your email setup is working.</p>',
            textBody: "This is a test email from Game Scheduler's Club Settings page. If you got this, your email setup is working.",
        });
        res.json({ sent_to: to, ...result });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;

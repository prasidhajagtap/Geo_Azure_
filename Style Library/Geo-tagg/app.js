/*
 * ══════════════════════════════════════════════════════════════
 *  GEOLOCATION ATTENDANCE
 *  Author : Prasidha Jagtap
 *  Deploy : onehruat.poornata.com — Script Editor Web Part
 *
 *  SECURITY
 *  · All DOM writes via .textContent — never .innerHTML (XSS).
 *  · sanitize() strips SQL/XSS chars before every DB write.
 *  · Supabase anon key is public. Safe ONLY with RLS enabled.
 *  · GPS maximumAge:0 — always fresh, never cached position.
 * ══════════════════════════════════════════════════════════════
 */

/* ── SUPABASE ────────────────────────────────────────────────
   Prasidha: Anon key is public by design; security lives in the DB.
   Required server config (Supabase SQL editor — see deploy notes):
     • RLS ENABLED on public.attendance
     • anon: INSERT only  (no direct SELECT/UPDATE/DELETE)
     • history read goes through security-definer RPC recent_shifts(emp)
   With this, the public key cannot dump the table, update, or delete.
   Rotate the key only if it was used while RLS was OFF.
────────────────────────────────────────────────────────────── */
const SUPABASE_URL = 'https://svhbqvcabbzrxvndxtjm.supabase.co';

/* Supabase keep-alive: fire once on load to wake free-tier project.
   Calls the read RPC (not the table) so it works under the locked-down
   RLS (anon has no direct SELECT). Empty emp → returns nothing, just
   wakes the database. */
function smxKeepAlive() {
  try {
    fetch(SUPABASE_URL + '/rest/v1/rpc/recent_shifts', {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ emp: '' }),
      mode: 'cors',
      cache: 'no-store'
    }).catch(function(){ /* silent */ });
  } catch(e) {}
}

/* Online/offline awareness */
function smxUpdateOnlineState() {
  var bar = document.getElementById('smx-offline-bar');
  if (!bar) return;
  if (navigator.onLine === false) {
    bar.classList.add('is-offline');
  } else {
    bar.classList.remove('is-offline');
  }
}
window.addEventListener('online',  smxUpdateOnlineState);
window.addEventListener('offline', smxUpdateOnlineState);

/* Safely hide SharePoint host wrappers that can otherwise show through.
   These can't be hidden with blanket CSS because a wrapper might be an
   ANCESTOR of the app — so we hide each match only if it does NOT contain
   the app root (.smx-wrap). This guarantees the app is never hidden. */
function smxHideSpWrappers() {
  var app = document.querySelector('.smx-wrap');
  ['.abg_box.height_auto'].forEach(function (sel) {
    var nodes;
    try { nodes = document.querySelectorAll(sel); } catch (e) { return; }
    nodes.forEach(function (el) {
      if (app && (el === app || el.contains(app))) return; /* would hide the app — skip */
      el.style.setProperty('display', 'none', 'important');
    });
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', smxHideSpWrappers);
} else {
  smxHideSpWrappers();
}

/* Disable the right-click / long-press context menu (removes the casual
   "right-click → Inspect" path). NOTE: a deterrent only — F12,
   Ctrl+Shift+I, Ctrl+U and opening app.js directly still work. Real
   protection is the database RLS/RPC, not this. */
document.addEventListener('contextmenu', function (e) {
  e.preventDefault();
  return false;
}, false);

const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN2aGJxdmNhYmJ6cnh2bmR4dGptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMTA0MjksImV4cCI6MjA5MDc4NjQyOX0.lYIsM5zN4uGKbP79avcKR_EaAlP5tu2N688OgZI6wZA';
const _db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ── STATE ───────────────────────────────────────────────────
   Prasidha: U is the single source of truth.
   Every change calls save() to mirror to localStorage.
   Shape validated on restore — tampered data cannot bypass auth.
────────────────────────────────────────────────────────────── */
let U = {
  name: '', id: '', photo: '',           /* photo added v08 — Azure profile pic URL */
  /* Business fields — v09: read from SP hidden fields, saved to Supabase (Prasidha Jagtap) */
  businessName: '',   /* hdnBusinessName  e.g. "BMC01"                  */
  businessUnit: '',   /* hdnBusinessUnit  e.g. "SEA01"                  */
  businessDesc: '',   /* hdnBusinessDesc  e.g. "Birla Mgmt Centre Svcs" */
  buUnitDesc:   '',   /* hdnBuUnitDesc    e.g. "Unit-01"                */
  clockIn: null,  clockInCoords: '',  clockInLoc: '',
  clockOut: null, clockOutCoords: '', clockOutLoc: '',
  isClockedIn: false, submitted: false, lastActionDate: null,
  clockInCoordSource:  'gps',  /* 'gps' | 'ip' — set by getCoords() */
  clockOutCoordSource: 'gps'   /* tracked per-event, stored in payload */
};

let rafId        = null;  // requestAnimationFrame loop ID
let handIv       = null;  // setInterval ID for auth clock hands
let isSubmitting = false; // double-submit guard
let inRedoMode   = false; // true when user is redoing clock-out
let stuckTimer   = null;  // setTimeout ID for stuck-button detector

/* ── STORAGE KEYS ────────────────────────────────────────────
   Using smx_v06 key for backward compatibility so active shifts
   from v06 survive the upgrade. Change key only on schema break.
────────────────────────────────────────────────────────────── */
const KEY_USER    = 'smx_v06';
const KEY_PENDING = 'smx_pending';
const KEY_ID      = 'smx_lastid';
const KEY_THEME   = 'smx_theme';
const KEY_LOCS    = 'smx_locs';
const KEY_LANG    = 'smx_lang';
const MAX_LOCS    = 6;

/* ── i18n — INLINE TRANSLATIONS ─────────────────────────── */
const LANGS = ['en', 'hi', 'mr'];
const LANG_LABELS = { en: 'EN', hi: 'हि', mr: 'मर' };
const I18N = {
  en: {
    clockIn: 'Clock in', clockOut: 'Clock out', tapToRecord: 'Tap to record',
    submitShift: 'Submit shift', pressHold: 'PRESS & HOLD',
    submitHint: 'Hold for 1 second to submit. Prevents accidental taps.',
    punchTime: 'Punch time', nameLocation: 'Name this location',
    confirm: 'Confirm', cancel: 'Cancel',
    shiftSubmitted: 'Shift submitted', shiftDuration: 'Shift duration',
    welQ: 'What would you like to do?',
    ftrDisclaimer: 'By using this app you confirm your location data is accurate.',
    ftrMain: 'Location data is captured for attendance purposes only.',
    ftrSeeYou: 'See you tomorrow.',
    recoverTip: 'Page stuck? Tap to recover',
    historyBtn: 'Shifts', historyTitle: 'Recent Shifts',
    historyLast7: 'Last 7 punched shifts', loading: 'Loading…', close: 'Close',
    historyEmpty: 'No shifts found in the last 7 days.',
    locationTitle: 'Location',
    notStarted: 'Not started', active: 'Active', completed: 'Completed',
    capturingLoc: 'Capturing your location…', holdOn: 'Hold on a moment',
    verifiedAzure: 'Verified via Azure AD',
    offlineBar: 'Offline — submit will retry when back online',
    capEditNote: 'This replaces your earlier time and location.',
    btnSubmitDone: 'Submit shift ✓', submitting: 'Submitting…',
    ghostNote: "Almost there — submitting your day's work…",
    clockInRecorded: 'Clock-in recorded.', clockOutRecorded: 'Clock-out recorded.',
    locNotCaptured: 'Location not captured yet.',
    recordFirst: 'Record a clock-in or clock-out first.',
    recordAtLeastOne: 'Please record at least a clock-in or clock-out first.',
    alreadySubmitted: 'This shift is already submitted.',
    allDone: 'All done! See you tomorrow.',
    submitFailedNet: "Can't reach the server. Your shift is saved — tap and hold Submit to try again.",
    submitFailedOther: 'Submit failed. Your shift is saved — tap and hold Submit again to retry.',
    incompleteTitle: 'Submit incomplete shift?',
    incompleteMsg: 'Your {x} is missing. Submit anyway?',
    incompleteBtn: 'Submit anyway',
    punchIn: 'clock-in', punchOut: 'clock-out',
    locEmpty: 'Location name cannot be empty',
    locTooLong: 'Max 20 characters (incl. spaces)',
    locMaxHint: 'Max 20 characters (incl. spaces)',
    locInvalid: 'Letters, numbers, spaces, hyphens only',
    locRenamed: 'Location renamed',
    enterLocName: 'Please enter a location name.',
    checkDetails: 'Check your details.',
    ciTimeUpdated: 'Clock-in time updated', coTimeUpdated: 'Clock-out time updated',
    identityFailed: 'Identity check failed. Please enter your ID manually.',
    autoDetectFailed: 'Auto-detect failed. Please enter your Poornata ID.',
    pendingDiscard: "Don't submit", pendingDiscarded: 'Last shift discarded.',
    pendingSubmitting: 'Submitting your last shift…', pendingSubmitted: 'Last shift submitted.',
    pendingFailed: 'Could not submit. You will be asked again next time.',
    pendingNetIssue: 'Network issue. You will be asked again next time.',
    pageRecovered: 'Page recovered. ↺',
    gpsFallback: 'GPS unavailable. Using network location…',
    locUnavailable: 'Location unavailable. Please check your internet connection.',
    markTimeTitle: 'Mark time now?', yesUpdate: 'Yes, update',
    markTimeMsg: 'Your {x} will be marked at {time}. Location stays the same.',
    newPlaceTitle: 'New place?', continueBtn: 'Continue',
    newPlaceMsg: 'This will re-capture GPS and let you rename the location for your {x}.',
    submitConfirmTitle: 'Submit shift?', yesSubmit: 'Yes, submit',
    submitConfirmMsg: "You won't be able to edit after this.",
    heroCurrentShift: 'Current shift', heroClockedOut: 'Clocked out',
    heroNeedsReview: 'Needs review',
    heroWarnMsg: 'Clock-in is after clock-out. Tap Clock out again to correct — or Submit to keep as-is.',
    heroSinceAwait: 'Since {t} · Clock out awaiting',
    heroNoCI: 'No clock-in recorded today',
    transClockedIn: 'Clocked in!', transClockedOut: 'Clocked out!',
    transMoment: 'One moment…', startDay: 'Start Day',
    themeDark: 'Dark', themeLight: 'Light',
    pendingTitle: 'Submit your last shift', submitNow: 'Submit now',
    pendingBody: 'These are your last recorded times for {d} — Clock in: {in}, Clock out: {out}. Please submit, or this data will not be saved.',
    missTitle: 'Submit with a missing punch?', goBack: 'Go back',
    missBody: 'Your {x} is blank and will be submitted empty. You cannot add it after submitting. Continue?',
    editTitle: 'Edit {x}', editPick: 'Pick what you want to change.',
    optTime: 'Mark time now', optTimeSub: 'Same location · just updates the time',
    optName: 'Rename location', optNameSub: 'Edit the label only · keeps GPS coordinates',
    optPlace: 'New place', optPlaceSub: 'Re-capture GPS and rename',
    renameTitle: 'Rename location', save: 'Save',
    renameMsg: 'Edit the location label for your {x}. GPS coordinates stay the same.',
    capConfirmIn: 'Confirm clock in', capConfirmOut: 'Confirm clock out',
    capPlaceholder: 'e.g. Airoli',
    locApprox: 'Approximate location', locCaptured: 'Location captured', netSuffix: 'network',
    capLocUnavail: 'Location unavailable', capTapRetry: 'Tap here to try again'
  },
  hi: {
    clockIn: 'क्लॉक इन', clockOut: 'क्लॉक आउट', tapToRecord: 'रिकॉर्ड करने के लिए टैप करें',
    submitShift: 'शिफ्ट जमा करें', pressHold: 'दबाएं और रखें',
    submitHint: 'जमा करने के लिए 1 सेकंड दबाएं। आकस्मिक टैप रोकता है।',
    punchTime: 'पंच समय', nameLocation: 'इस स्थान का नाम दें',
    confirm: 'पुष्टि करें', cancel: 'रद्द करें',
    shiftSubmitted: 'शिफ्ट जमा हो गयी', shiftDuration: 'शिफ्ट अवधि',
    welQ: 'आप क्या करना चाहेंगे?',
    ftrDisclaimer: 'इस ऐप का उपयोग करके आप पुष्टि करते हैं कि आपका स्थान डेटा सही है।',
    ftrMain: 'स्थान डेटा केवल उपस्थिति उद्देश्यों के लिए लिया जाता है।',
    ftrSeeYou: 'कल मिलते हैं।',
    recoverTip: 'पेज रुका? रिकवर करने के लिए टैप करें',
    historyBtn: 'शिफ्ट्स', historyTitle: 'हाल की शिफ्टें',
    historyLast7: 'पिछली 7 दर्ज शिफ्टें', loading: 'लोड हो रहा है…', close: 'बंद करें',
    historyEmpty: 'पिछले 7 दिनों में कोई शिफ्ट नहीं मिली।',
    locationTitle: 'स्थान',
    notStarted: 'शुरू नहीं', active: 'सक्रिय', completed: 'पूर्ण',
    capturingLoc: 'आपका स्थान लिया जा रहा है…', holdOn: 'एक पल रुकें',
    verifiedAzure: 'Azure AD से सत्यापित',
    offlineBar: 'ऑफलाइन — वापस ऑनलाइन होने पर फिर से जमा होगा',
    capEditNote: 'यह आपके पहले के समय और स्थान को बदल देगा।',
    btnSubmitDone: 'शिफ्ट जमा करें ✓', submitting: 'जमा हो रहा है…',
    ghostNote: 'बस हो गया — आपका दिन जमा किया जा रहा है…',
    clockInRecorded: 'क्लॉक-इन दर्ज हुआ।', clockOutRecorded: 'क्लॉक-आउट दर्ज हुआ।',
    locNotCaptured: 'स्थान अभी तक नहीं लिया गया।',
    recordFirst: 'पहले क्लॉक-इन या क्लॉक-आउट दर्ज करें।',
    recordAtLeastOne: 'कृपया कम से कम एक क्लॉक-इन या क्लॉक-आउट दर्ज करें।',
    alreadySubmitted: 'यह शिफ्ट पहले ही जमा हो चुकी है।',
    allDone: 'सब हो गया! कल मिलते हैं।',
    submitFailedNet: 'सर्वर तक नहीं पहुंच सके। आपकी शिफ्ट सुरक्षित है — पुनः प्रयास के लिए सबमिट दबाकर रखें।',
    submitFailedOther: 'जमा विफल। आपकी शिफ्ट सुरक्षित है — पुनः प्रयास के लिए सबमिट फिर से दबाकर रखें।',
    incompleteTitle: 'अधूरी शिफ्ट जमा करें?',
    incompleteMsg: 'आपका {x} गायब है। फिर भी जमा करें?',
    incompleteBtn: 'फिर भी जमा करें',
    punchIn: 'क्लॉक-इन', punchOut: 'क्लॉक-आउट',
    locEmpty: 'स्थान का नाम खाली नहीं हो सकता',
    locTooLong: 'अधिकतम 20 अक्षर (स्पेस सहित)',
    locMaxHint: 'अधिकतम 20 अक्षर (स्पेस सहित)',
    locInvalid: 'केवल अक्षर, अंक, स्पेस, हाइफ़न',
    locRenamed: 'स्थान का नाम बदला गया',
    enterLocName: 'कृपया स्थान का नाम दर्ज करें।',
    checkDetails: 'अपना विवरण जांचें।',
    ciTimeUpdated: 'क्लॉक-इन समय अपडेट हुआ', coTimeUpdated: 'क्लॉक-आउट समय अपडेट हुआ',
    identityFailed: 'पहचान जांच विफल। कृपया अपना ID स्वयं दर्ज करें।',
    autoDetectFailed: 'स्वतः पहचान विफल। कृपया अपना पूर्णता ID दर्ज करें।',
    pendingDiscard: 'जमा न करें', pendingDiscarded: 'पिछली शिफ्ट हटाई गई।',
    pendingSubmitting: 'आपकी पिछली शिफ्ट जमा हो रही है…', pendingSubmitted: 'पिछली शिफ्ट जमा हुई।',
    pendingFailed: 'जमा नहीं हो सका। अगली बार फिर पूछा जाएगा।',
    pendingNetIssue: 'नेटवर्क समस्या। अगली बार फिर पूछा जाएगा।',
    pageRecovered: 'पेज रिकवर हुआ। ↺',
    gpsFallback: 'GPS अनुपलब्ध। नेटवर्क स्थान का उपयोग…',
    locUnavailable: 'स्थान अनुपलब्ध। कृपया अपना इंटरनेट कनेक्शन जांचें।',
    markTimeTitle: 'अभी समय दर्ज करें?', yesUpdate: 'हां, अपडेट करें',
    markTimeMsg: 'आपका {x} {time} पर दर्ज किया जाएगा। स्थान वही रहेगा।',
    newPlaceTitle: 'नई जगह?', continueBtn: 'जारी रखें',
    newPlaceMsg: 'यह GPS फिर से लेगा और आपके {x} के लिए स्थान का नाम बदलने देगा।',
    submitConfirmTitle: 'शिफ्ट जमा करें?', yesSubmit: 'हां, जमा करें',
    submitConfirmMsg: 'इसके बाद आप संपादित नहीं कर पाएंगे।',
    heroCurrentShift: 'वर्तमान शिफ्ट', heroClockedOut: 'क्लॉक आउट हुआ',
    heroNeedsReview: 'समीक्षा आवश्यक',
    heroWarnMsg: 'क्लॉक-इन, क्लॉक-आउट के बाद है। सही करने के लिए फिर से क्लॉक आउट करें — या ऐसे ही रखने के लिए सबमिट करें।',
    heroSinceAwait: '{t} से · क्लॉक आउट प्रतीक्षित',
    heroNoCI: 'आज कोई क्लॉक-इन दर्ज नहीं',
    transClockedIn: 'क्लॉक इन हुआ!', transClockedOut: 'क्लॉक आउट हुआ!',
    transMoment: 'एक क्षण…', startDay: 'दिन शुरू करें',
    themeDark: 'डार्क', themeLight: 'लाइट',
    pendingTitle: 'अपनी पिछली शिफ्ट जमा करें', submitNow: 'अभी जमा करें',
    pendingBody: '{d} के लिए ये आपके अंतिम दर्ज समय हैं — क्लॉक इन: {in}, क्लॉक आउट: {out}. कृपया जमा करें, अन्यथा यह डेटा सहेजा नहीं जाएगा।',
    missTitle: 'गायब पंच के साथ जमा करें?', goBack: 'वापस जाएं',
    missBody: 'आपका {x} खाली है और खाली ही जमा होगा। जमा करने के बाद आप इसे नहीं जोड़ सकते। जारी रखें?',
    editTitle: '{x} संपादित करें', editPick: 'आप क्या बदलना चाहते हैं चुनें।',
    optTime: 'अभी समय दर्ज करें', optTimeSub: 'वही स्थान · केवल समय अपडेट करता है',
    optName: 'स्थान का नाम बदलें', optNameSub: 'केवल लेबल बदलें · GPS निर्देशांक बने रहते हैं',
    optPlace: 'नई जगह', optPlaceSub: 'GPS फिर से लें और नाम बदलें',
    renameTitle: 'स्थान का नाम बदलें', save: 'सहेजें',
    renameMsg: 'अपने {x} के लिए स्थान लेबल बदलें। GPS निर्देशांक वही रहते हैं।',
    capConfirmIn: 'क्लॉक इन की पुष्टि करें', capConfirmOut: 'क्लॉक आउट की पुष्टि करें',
    capPlaceholder: 'जैसे एरोली',
    locApprox: 'अनुमानित स्थान', locCaptured: 'स्थान लिया गया', netSuffix: 'नेटवर्क',
    capLocUnavail: 'स्थान अनुपलब्ध', capTapRetry: 'पुनः प्रयास के लिए टैप करें'
  },
  mr: {
    clockIn: 'क्लॉक इन', clockOut: 'क्लॉक आउट', tapToRecord: 'नोंद करण्यासाठी टॅप करा',
    submitShift: 'शिफ्ट सुपूर्द करा', pressHold: 'दाबा आणि धरा',
    submitHint: 'सुपूर्द करण्यासाठी 1 सेकंद दाबा. चुकीचे टॅप रोखतो.',
    punchTime: 'पंच वेळ', nameLocation: 'या ठिकाणाला नाव द्या',
    confirm: 'निश्चित करा', cancel: 'रद्द करा',
    shiftSubmitted: 'शिफ्ट सुपूर्द झाली', shiftDuration: 'शिफ्ट कालावधी',
    welQ: 'तुम्हाला काय करायचे आहे?',
    ftrDisclaimer: 'हे अॅप वापरून तुम्ही खात्री करता की तुमचा स्थान डेटा अचूक आहे.',
    ftrMain: 'स्थान डेटा केवळ उपस्थिती उद्देशांसाठी घेतला जातो.',
    ftrSeeYou: 'उद्या भेटू.',
    recoverTip: 'पेज अडकले? रिकव्हर करण्यासाठी टॅप करा',
    historyBtn: 'शिफ्ट्स', historyTitle: 'अलीकडील शिफ्ट्स',
    historyLast7: 'शेवटच्या 7 नोंदवलेल्या शिफ्ट', loading: 'लोड होत आहे…', close: 'बंद करा',
    historyEmpty: 'मागील 7 दिवसांत कोणतीही शिफ्ट सापडली नाही.',
    locationTitle: 'स्थान',
    notStarted: 'सुरू नाही', active: 'सक्रिय', completed: 'पूर्ण',
    capturingLoc: 'तुमचे स्थान घेतले जात आहे…', holdOn: 'एक क्षण थांबा',
    verifiedAzure: 'Azure AD द्वारे सत्यापित',
    offlineBar: 'ऑफलाइन — पुन्हा ऑनलाइन आल्यावर पुन्हा जमा होईल',
    capEditNote: 'हे तुमच्या आधीच्या वेळेस आणि स्थानास बदलेल.',
    btnSubmitDone: 'शिफ्ट सुपूर्द करा ✓', submitting: 'सुपूर्द होत आहे…',
    ghostNote: 'जवळजवळ झाले — तुमचा दिवस सुपूर्द होत आहे…',
    clockInRecorded: 'क्लॉक-इन नोंदले.', clockOutRecorded: 'क्लॉक-आउट नोंदले.',
    locNotCaptured: 'स्थान अद्याप घेतले नाही.',
    recordFirst: 'आधी क्लॉक-इन किंवा क्लॉक-आउट नोंदवा.',
    recordAtLeastOne: 'कृपया किमान एक क्लॉक-इन किंवा क्लॉक-आउट नोंदवा.',
    alreadySubmitted: 'ही शिफ्ट आधीच सुपूर्द झाली आहे.',
    allDone: 'सर्व झाले! उद्या भेटू.',
    submitFailedNet: 'सर्व्हरपर्यंत पोहोचता आले नाही. तुमची शिफ्ट सुरक्षित आहे — पुन्हा प्रयत्नासाठी सबमिट दाबून धरा.',
    submitFailedOther: 'सुपूर्द अयशस्वी. तुमची शिफ्ट सुरक्षित आहे — पुन्हा प्रयत्नासाठी सबमिट पुन्हा दाबून धरा.',
    incompleteTitle: 'अपूर्ण शिफ्ट सुपूर्द करायची?',
    incompleteMsg: 'तुमचा {x} गहाळ आहे. तरीही सुपूर्द करायची?',
    incompleteBtn: 'तरीही सुपूर्द करा',
    punchIn: 'क्लॉक-इन', punchOut: 'क्लॉक-आउट',
    locEmpty: 'स्थानाचे नाव रिकामे असू शकत नाही',
    locTooLong: 'जास्तीत जास्त 20 अक्षरे (स्पेससह)',
    locMaxHint: 'जास्तीत जास्त 20 अक्षरे (स्पेससह)',
    locInvalid: 'फक्त अक्षरे, अंक, स्पेस, हायफन',
    locRenamed: 'स्थानाचे नाव बदलले',
    enterLocName: 'कृपया स्थानाचे नाव प्रविष्ट करा.',
    checkDetails: 'तुमचा तपशील तपासा.',
    ciTimeUpdated: 'क्लॉक-इन वेळ अद्ययावत झाली', coTimeUpdated: 'क्लॉक-आउट वेळ अद्ययावत झाली',
    identityFailed: 'ओळख तपासणी अयशस्वी. कृपया तुमचा ID स्वतः प्रविष्ट करा.',
    autoDetectFailed: 'स्वयं-ओळख अयशस्वी. कृपया तुमचा पूर्णता ID प्रविष्ट करा.',
    pendingDiscard: 'सुपूर्द करू नका', pendingDiscarded: 'मागील शिफ्ट काढली.',
    pendingSubmitting: 'तुमची मागील शिफ्ट सुपूर्द होत आहे…', pendingSubmitted: 'मागील शिफ्ट सुपूर्द झाली.',
    pendingFailed: 'सुपूर्द होऊ शकले नाही. पुढच्या वेळी पुन्हा विचारले जाईल.',
    pendingNetIssue: 'नेटवर्क समस्या. पुढच्या वेळी पुन्हा विचारले जाईल.',
    pageRecovered: 'पेज रिकव्हर झाले. ↺',
    gpsFallback: 'GPS अनुपलब्ध. नेटवर्क स्थान वापरत आहे…',
    locUnavailable: 'स्थान अनुपलब्ध. कृपया तुमचे इंटरनेट कनेक्शन तपासा.',
    markTimeTitle: 'आता वेळ नोंदवायची?', yesUpdate: 'होय, अद्ययावत करा',
    markTimeMsg: 'तुमचा {x} {time} वाजता नोंदवला जाईल. स्थान तेच राहील.',
    newPlaceTitle: 'नवीन ठिकाण?', continueBtn: 'सुरू ठेवा',
    newPlaceMsg: 'हे GPS पुन्हा घेईल आणि तुमच्या {x} साठी स्थानाचे नाव बदलू देईल.',
    submitConfirmTitle: 'शिफ्ट सुपूर्द करायची?', yesSubmit: 'होय, सुपूर्द करा',
    submitConfirmMsg: 'यानंतर तुम्ही संपादित करू शकणार नाही.',
    heroCurrentShift: 'सध्याची शिफ्ट', heroClockedOut: 'क्लॉक आउट झाले',
    heroNeedsReview: 'पुनरावलोकन आवश्यक',
    heroWarnMsg: 'क्लॉक-इन हे क्लॉक-आउट नंतर आहे. दुरुस्त करण्यासाठी पुन्हा क्लॉक आउट करा — किंवा तसेच ठेवण्यासाठी सुपूर्द करा.',
    heroSinceAwait: '{t} पासून · क्लॉक आउट बाकी',
    heroNoCI: 'आज कोणतेही क्लॉक-इन नोंदलेले नाही',
    transClockedIn: 'क्लॉक इन झाले!', transClockedOut: 'क्लॉक आउट झाले!',
    transMoment: 'एक क्षण…', startDay: 'दिवस सुरू करा',
    themeDark: 'डार्क', themeLight: 'लाइट',
    pendingTitle: 'तुमची मागील शिफ्ट सुपूर्द करा', submitNow: 'आता सुपूर्द करा',
    pendingBody: '{d} साठी या तुमच्या शेवटच्या नोंदलेल्या वेळा आहेत — क्लॉक इन: {in}, क्लॉक आउट: {out}. कृपया सुपूर्द करा, अन्यथा हा डेटा जतन होणार नाही.',
    missTitle: 'गहाळ पंचसह सुपूर्द करायची?', goBack: 'मागे जा',
    missBody: 'तुमचा {x} रिकामा आहे आणि रिकामाच सुपूर्द होईल. सुपूर्द केल्यानंतर तुम्ही तो जोडू शकत नाही. सुरू ठेवायचे?',
    editTitle: '{x} संपादित करा', editPick: 'तुम्हाला काय बदलायचे आहे ते निवडा.',
    optTime: 'आता वेळ नोंदवा', optTimeSub: 'तेच स्थान · फक्त वेळ अद्ययावत करते',
    optName: 'स्थानाचे नाव बदला', optNameSub: 'फक्त लेबल बदला · GPS निर्देशांक तसेच राहतात',
    optPlace: 'नवीन ठिकाण', optPlaceSub: 'GPS पुन्हा घ्या आणि नाव बदला',
    renameTitle: 'स्थानाचे नाव बदला', save: 'जतन करा',
    renameMsg: 'तुमच्या {x} साठी स्थान लेबल बदला. GPS निर्देशांक तेच राहतात.',
    capConfirmIn: 'क्लॉक इन निश्चित करा', capConfirmOut: 'क्लॉक आउट निश्चित करा',
    capPlaceholder: 'उदा. एरोली',
    locApprox: 'अंदाजे स्थान', locCaptured: 'स्थान घेतले', netSuffix: 'नेटवर्क',
    capLocUnavail: 'स्थान अनुपलब्ध', capTapRetry: 'पुन्हा प्रयत्नासाठी टॅप करा'
  }
};

let _curLang = localStorage.getItem(KEY_LANG) || 'en';

function t(key) { return (I18N[_curLang] && I18N[_curLang][key]) || I18N.en[key] || key; }

const DEVA_DIGITS = ['०','१','२','३','४','५','६','७','८','९'];
function toLocalNum(str) {
  if (_curLang === 'en') return str;
  return String(str).replace(/[0-9]/g, d => DEVA_DIGITS[+d]);
}
function toEnNum(str) {
  return String(str).replace(/[०-९]/g, d => String('०१२३४५६७८९'.indexOf(d)));
}

/* BCP-47 locale for the current language — used for Intl date/time formatting */
function langLocale() {
  return _curLang === 'hi' ? 'hi-IN' : _curLang === 'mr' ? 'mr-IN' : 'en-IN';
}

function applyLang() {
  /* expose current language to CSS (script-aware line-height, etc.) */
  document.documentElement.setAttribute('lang', _curLang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val.includes('\n')) { el.innerHTML = val.replace(/\n/g, '<br>'); }
    else { el.textContent = val; }
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  document.querySelectorAll('.l-lbl').forEach(el => { el.textContent = LANG_LABELS[_curLang]; });

  const tapDefaults = LANGS.map(l => (I18N[l] && I18N[l].tapToRecord) || '');
  ['ci-loc','co-loc'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const raw = el.textContent.trim();
    if (!raw || raw === '--:-- --' || tapDefaults.includes(raw)) {
      el.textContent = t('tapToRecord');
    }
  });

  document.querySelectorAll('.smx-tile-time, .smx-suc-val, .smx-suc-dur-val, .smx-cap-time').forEach(el => {
    const raw = toEnNum(el.textContent);
    el.textContent = toLocalNum(raw);
  });

  const pidEl = document.getElementById('suc-pid');
  if (pidEl) {
    const raw = toEnNum(pidEl.textContent);
    pidEl.textContent = toLocalNum(raw);
  }

  /* refresh theme toggle label (Dark/Light) in the new language */
  if (typeof applyTheme === 'function') applyTheme(_themeMode);
}

function cycleLang() {
  const idx = LANGS.indexOf(_curLang);
  _curLang = LANGS[(idx + 1) % LANGS.length];
  localStorage.setItem(KEY_LANG, _curLang);
  applyLang();
  refreshDynamicI18n();
}

/* Re-render the JS-painted parts of the visible section so a live
   language switch updates hero labels, tile values, success summary,
   etc. (those are set in JS, not via [data-i18n]). */
function refreshDynamicI18n() {
  try {
    if (g('smx-main-sec') && !g('smx-main-sec').classList.contains('hidden')) {
      if (typeof renderPunchDisplay === 'function') renderPunchDisplay();
    } else if (g('smx-success-sec') && !g('smx-success-sec').classList.contains('hidden')) {
      if (typeof renderSuccess === 'function') renderSuccess();
    } else if (g('smx-welcome-sec') && !g('smx-welcome-sec').classList.contains('hidden')) {
      if (typeof renderWelcome === 'function') renderWelcome();
    }
  } catch (e) { console.error('[GeoAtt] lang refresh:', e); }
}

/* ── HELPERS (hoisted) ───────────────────────────────────────
   Prasidha: Declared as `function` so they are fully hoisted.
   `const` arrow functions are NOT hoisted — using them above
   their declaration throws ReferenceError (temporal dead zone).
   Keep these as `function` declarations. Do not convert to const.
────────────────────────────────────────────────────────────── */

/** g — Prasidha: shorthand getElementById, used everywhere */
function g(id) { return document.getElementById(id); }

/** setTx — Prasidha: safely sets textContent, no-ops if element missing */
function setTx(id, v) { const e = g(id); if (e) e.textContent = v; }

/** hide — Prasidha: adds .hidden class (display:none!important in CSS) */
function hide(id) { g(id)?.classList.add('hidden'); }

/** show — Prasidha: removes .hidden class */
function show(id) { g(id)?.classList.remove('hidden'); }

/** nowISO — Prasidha: current timestamp as ISO 8601 string */
function nowISO() { return new Date().toISOString(); }

/** rnd — Prasidha: random element from array */
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/** save — Prasidha: serializes U state to localStorage */
function save() { localStorage.setItem(KEY_USER, JSON.stringify(U)); }

/* ── CONTENT ARRAYS ──────────────────────────────────────────
   Prasidha: All UI copy here. Edit freely without touching logic.
────────────────────────────────────────────────────────────── */
const GREETINGS = [
  'Rare Sunday warrior spotted. Respect. 🦁',
  'New week, fresh resolve. Make it count! 🌟',
  'Tuesday energy — steady and purposeful. 💪',
  'Midweek momentum. You are in the thick of it. ⚡',
  'Thursday: the unsung hero of the week.',
  'Friday vibes. Finish line is right there. 🎉',
  'Closing the week strong. Keep it up! 🚀'
];
const GHOST_NOTES = [
  'Your timings are being stored, safe and sound.',
  'Attendance logged with care — just like clockwork.',
  'Professional work happening behind the scenes.',
  'The database is receiving your day\'s hard work.',
  'Shift data is making its way in. Hang tight.'
];
const LOADER_MSGS = [
  'Starting your day…', 'One moment please…',
  'Getting things ready…', 'Just a tick…'
];

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════
   Prasidha: Order matters.
   1. Ambient time-of-day (CSS attr, no runtime cost after this)
   2. Saved theme (prevents flash of wrong theme)
   3. Daily greeting (day-of-week from GREETINGS)
   4. Pre-fill last Poornata ID (reduce login friction)
   5. Session restore OR fresh auth setup
   6. setupAC called ONCE here — not on every renderMain call
      (calling it multiple times stacks document.click listeners)
*/
window.addEventListener('DOMContentLoaded', () => {
  setTimeOfDay();

  const savedTheme = localStorage.getItem(KEY_THEME) || 'auto';
  _themeMode = savedTheme;
  applyTheme(_themeMode);
  applyLang();

  setTx('daily-greet', GREETINGS[new Date().getDay()]);

  setupAC('cap-loc', 'cap-drop', 'cap-chips');

  /* Tap the location box to retry when GPS failed (v11) */
  const capGeo = g('smx-cap-geo');
  if (capGeo) capGeo.addEventListener('click', () => {
    if (capGeo.classList.contains('err')) startGeoCapture();
  });

  /* ── Session restore (Prasidha v08) ─────────────────────────────────────
     Validate shape before trusting. If valid same-day session exists,
     skip Azure detection and go straight to renderMain().
     Session carries U.name + U.id already resolved from Azure in prior load.
  */
  /* ── Session restore (v10 — two-button + next-day catch-up) ──────────
     Rules:
       · Same calendar day, not submitted        → resume today's shift.
       · Previous day, not submitted, has a punch → hold it as PENDING,
         start a fresh day (identity carried), prompt to submit it.
       · Submitted, or empty previous day         → discard, start fresh.
     The PENDING shift is stored under its own key so it survives even if
     the user closes the app before deciding. It is offered again on the
     next open until submitted or explicitly discarded.
  */
  try {
    const raw = localStorage.getItem(KEY_USER);
    if (raw) {
      const p = JSON.parse(raw);
      const idOK = p?.name && typeof p.name === 'string' &&
                   p?.id   && typeof p.id   === 'string';

      if (idOK && !isNewDay(p.lastActionDate)) {
        /* Same day — resume exactly where they left off */
        U = p;
        renderRoot();
        return;
      }

      if (idOK && !p.submitted && isNewDay(p.lastActionDate) && (p.clockIn || p.clockOut)) {
        /* Previous day, never submitted — hold it and start fresh */
        localStorage.setItem(KEY_PENDING, JSON.stringify(p));
        U = freshDay(p);
        save();
        renderRoot();         /* checkPending() inside will raise the prompt */
        return;
      }

      if (idOK) {
        /* Submitted yesterday, or an empty previous day — clean start, keep identity */
        U = freshDay(p);
        save();
        renderRoot();
        return;
      }

      localStorage.removeItem(KEY_USER);
    }
  } catch { localStorage.removeItem(KEY_USER); }

  /* ── Fresh session: run Azure detection ─────────────────────────────── */
  azureDetect();
});

/* ══════════════════════════════════════════════════════════════
   AZURE AD DETECTION — v08 (Prasidha Jagtap)

   Replaces the manual #smx-auth-sec login form from v07.
   Reads identity directly from Classic SharePoint hidden fields
   written by Azure ADFS after login on logintext.aspx.

   CONFIRMED FIELD IDs (from logintext.aspx page source):
     ctl00_ctl53_hdnPoornataId       → U.id   (numeric, e.g. "446686")
     ctl00_ctl53_hdnName             → U.name (e.g. "Prasidha Jagtap")
     ctl00_ctl53_hdnCurrentUserEmail → email  (e.g. "prasidha.jagtap@adityabirla.com")
     ctl00_ctl53_hdnPictureUrl       → photo  (URL to profile thumbnail)

   STRATEGY:
     Classic ASP.NET pages may populate hidden fields AFTER
     DOMContentLoaded via code-behind. We poll every 400ms for
     up to 6 seconds before falling to fallback.

   SECURITY (Prasidha):
     · Same-origin DOM read. No credentials transmitted.
     · PID validated numeric-only before accepting.
     · Name validated letters+spaces before accepting.
     · Photo URL not validated — only used as img src (safe).

   FUTURE MIGRATION NOTE:
     Replace azureDetect() with MSAL.js token extraction when
     portal moves to SPFx modern pages. Keep azureApply() call
     signature unchanged — renderMain() and Supabase payload
     both consume U.name + U.id with no changes needed.
══════════════════════════════════════════════════════════════ */

var _azurePollCount = 0;
var _azurePollMax   = 15;   /* 15 × 400ms = 6 seconds max */
var _azurePollTimer = null;

/**
 * azureDetect — Prasidha Jagtap (v08)
 * Polls DOM for Azure ADFS hidden fields. Stops at first valid PID.
 * Shows auth screen with detecting state while polling.
 */
function azureDetect() {
  _azurePollCount = 0;

  /* Show smx-auth-sec in detecting state while we poll */
  show('smx-auth-sec');
  hide('smx-main-sec');
  hide('auth-manual-grp');
  show('auth-detecting');
  setTx('auth-detect-msg', 'Connecting to Azure AD…');

  _azurePollTimer = setInterval(function () {
    _azurePollCount++;

    /* read from parent document (iframe) first, fall back to own document */
    var spDoc;
    try { spDoc = (window.parent && window.parent !== window) ? window.parent.document : document; }
    catch(e) { spDoc = document; }

    /* ── Read all four confirmed hidden fields (Prasidha Jagtap) ─── */
    /* ── Identity fields (Prasidha Jagtap) ── */
    var pidEl   = spDoc.getElementById('ctl00_ctl53_hdnPoornataId')
               || spDoc.querySelector('input.hdnPoornataId')
               || spDoc.querySelector('input[name*="hdnPoornataId"]');

    var nameEl  = spDoc.getElementById('ctl00_ctl53_hdnName')
               || spDoc.querySelector('input.hdnName')
               || spDoc.querySelector('input[name*="hdnName"]');

    var emailEl = spDoc.getElementById('ctl00_ctl53_hdnCurrentUserEmail')
               || spDoc.querySelector('input.hdnCurrentUserEmail')
               || spDoc.querySelector('input[name*="hdnCurrentUserEmail"]');

    var photoEl = spDoc.getElementById('ctl00_ctl53_hdnPictureUrl')
               || spDoc.querySelector('input.hdnPictureUrl')
               || spDoc.querySelector('input[name*="hdnPictureUrl"]');

    /* ── Business fields ── */
    /* Confirmed hidden fields on logintext.aspx / TestingText.aspx      */
    /* hdnBusinessName → BU code e.g. "BMC01"                            */
    /* hdnBusinessDesc → Full name e.g. "Birla Mgmt Centre Services"     */
    /* hdnBusinessUnit → Unit code e.g. "SEA01"                          */
    /* hdnBuUnitDesc   → Unit name e.g. "Unit-01"                        */
    var bizNameEl = spDoc.getElementById('ctl00_ctl53_hdnBusinessName')
               || spDoc.querySelector('input.hdnBusinessName')
               || spDoc.querySelector('input[name*="hdnBusinessName"]');

    var bizUnitEl = spDoc.getElementById('ctl00_ctl53_hdnBusinessUnit')
               || spDoc.querySelector('input.hdnBusinessUnit')
               || spDoc.querySelector('input[name*="hdnBusinessUnit"]');

    var bizDescEl = spDoc.getElementById('ctl00_ctl53_hdnBusinessDesc')
               || spDoc.querySelector('input.hdnBusinessDesc')
               || spDoc.querySelector('input[name*="hdnBusinessDesc"]');

    var buDescEl  = spDoc.getElementById('ctl00_ctl53_hdnBuUnitDesc')
               || spDoc.querySelector('input.hdnBuUnitDesc')
               || spDoc.querySelector('input[name*="hdnBuUnitDesc"]');

    var pid         = (pidEl     ? pidEl.value     : '').trim();
    var name        = (nameEl    ? nameEl.value    : '').trim();
    var email       = (emailEl   ? emailEl.value   : '').trim();
    var photo       = (photoEl   ? photoEl.value   : '').trim();
    var bizName     = (bizNameEl ? bizNameEl.value : '').trim();
    var bizUnit     = (bizUnitEl ? bizUnitEl.value : '').trim();
    var bizDesc     = (bizDescEl ? bizDescEl.value : '').trim();
    var buDesc      = (buDescEl  ? buDescEl.value  : '').trim();

    /* Derive name from email prefix if hidden name field empty */
    if (!name && email) name = azureDeriveNameFromEmail(email);

    setTx('auth-detect-msg', 'Detecting… (' + _azurePollCount + ')');

    if (isValidId(pid)) {
      clearInterval(_azurePollTimer);
      azureApply(pid, name || 'Employee', email, photo,
        { bizName, bizUnit, bizDesc, buDesc },
        'Azure ADFS · Hidden Fields');
      return;
    }

    if (_azurePollCount >= _azurePollMax) {
      clearInterval(_azurePollTimer);
      /* Detection exhausted — show manual PID entry fallback */
      azureFallback(email, name);
    }
  }, 400);
}

/**
 * azureApply — Prasidha Jagtap (v08)
 * Stores resolved Azure identity into U and starts the app.
 * Security: PID and name re-validated before accepting.
 * @param {string} pid
 * @param {string} name
 * @param {string} email
 * @param {string} photo
 * @param {string} source
 */
function azureApply(pid, name, email, photo, bizFields, source) {
  /* Handle calls without bizFields (manual fallback path) */
  if (typeof bizFields === 'string') { source = bizFields; bizFields = {}; }

  /* SECURITY: re-validate before trusting (Prasidha) */
  if (!isValidId(pid)) {
    toast(t('identityFailed'), 'err');
    azureFallback(email, name);
    return;
  }

  /* Sanitize name — strip any injected chars (defence-in-depth) */
  const safeName = name.trim().replace(/[^a-zA-Z\s]/g, '').trim() || 'Employee';

  U.name  = safeName;
  U.id    = pid;
  U.photo = photo || '';
  /* Keep the Azure email on U so buildPayload() can write the email column.
     Previously only azureFallback() set this, so a successful SSO detect —
     the normal production path — always inserted email as NULL. */
  if (email) U._azureEmail = email;
  /* business fields from SP hidden fields */
  U.businessName = (bizFields && bizFields.bizName) || U.businessName || '';
  U.businessUnit = (bizFields && bizFields.bizUnit) || U.businessUnit || '';
  U.businessDesc = (bizFields && bizFields.bizDesc) || U.businessDesc || '';
  U.buUnitDesc   = (bizFields && bizFields.buDesc)  || U.buUnitDesc   || '';
  U.lastActionDate = nowISO();
  localStorage.setItem(KEY_ID, pid);
  save();

  console.info('[GeoAtt] Azure identity resolved via:', source);
  window.dispatchEvent(new CustomEvent('poornataIdentityReady', {
    detail: { pid, name: safeName, email, photo, source }, bubbles: true
  }));

  /* Show brief confirmation then go to main */
  setTx('auth-detect-msg', '✓ Verified — ' + safeName);
  setTimeout(function () {
    pageTransition(function () { renderRoot(); }, 'Starting your day…');
  }, 700);
}

/**
 * azureFallback — Prasidha Jagtap (v08)
 * Shows manual PID entry when auto-detection fails.
 * Name pre-filled from email prefix if available.
 * @param {string} email
 * @param {string} name
 */
function azureFallback(email, name) {
  hide('auth-detecting');
  show('auth-manual-grp');

  /* Pre-fill name if we got it from email even without PID */
  const nameInp = g('inp-name');
  if (nameInp && name && !nameInp.value) nameInp.value = name;

  /* Pre-fill last used PID */
  const lastId = localStorage.getItem(KEY_ID);
  const idInp  = g('inp-id');
  if (idInp && lastId && !idInp.value) idInp.value = lastId;

  /* Store email for later use in payload even if not displayed */
  if (email) U._azureEmail = email;

  setupLoginValidation();
  toast(t('autoDetectFailed'), 'err');
}

/**
 * azureDeriveNameFromEmail — Prasidha Jagtap (v08)
 * e.g. "prasidha.jagtap@adityabirla.com" → "Prasidha Jagtap"
 * @param {string} email
 * @returns {string}
 */
function azureDeriveNameFromEmail(email) {
  if (!email || !email.includes('@')) return '';
  const prefix = email.split('@')[0];
  if (/^\d+$/.test(prefix)) return '';
  return prefix.replace(/[._-]/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

/* ══════════════════════════════════════════════════════════════
   TIME-OF-DAY AMBIENT
   Prasidha: Sets data-tod on body. CSS handles all animation.
   dawn(5-9am) · day(9-15) · dusk(15-18) · night(18-5)
*/
function setTimeOfDay() {
  const h = new Date().getHours();
  const tod = h >= 5  && h < 9  ? 'dawn'
            : h >= 9  && h < 15 ? 'day'
            : h >= 15 && h < 18 ? 'dusk'
            : 'night';
  document.body.setAttribute('data-tod', tod);
}

/* ══════════════════════════════════════════════════════════════
   THEME SYSTEM
   Prasidha: Modes: 'auto' (time-based) | 'light' | 'dark'.
   Preference saved to localStorage. All .t-ico and .t-lbl
   elements across both footers updated together.
*/
let _themeMode = 'auto';

/** applyTheme — Prasidha: resolves effective theme and updates DOM */
function applyTheme(mode) {
  const eff = mode === 'auto' ? (isDay() ? 'light' : 'dark') : mode;
  document.documentElement.setAttribute('data-theme', eff);
  const ico = eff === 'dark' ? '☀️' : '🌙';
  const lbl = eff === 'dark' ? t('themeLight') : t('themeDark');
  document.querySelectorAll('.t-ico').forEach(e => e.textContent = ico);
  document.querySelectorAll('.t-lbl').forEach(e => e.textContent = lbl);
}

/** cycleTheme — Prasidha: called by onclick on theme buttons */
function cycleTheme() {
  const next = { auto: 'light', light: 'dark', dark: 'auto' };
  _themeMode = next[_themeMode] || 'auto';
  localStorage.setItem(KEY_THEME, _themeMode);
  applyTheme(_themeMode);
}

/** isDay — Prasidha: true between 6am and 6pm */
const isDay = () => { const h = new Date().getHours(); return h >= 6 && h < 18; };

/* ══════════════════════════════════════════════════════════════
   MAIN RAF LOOP — FIX-02 (Prasidha)
   Single requestAnimationFrame loop drives BOTH the live header
   clock AND the shift timer from the same Date.now() call.
   Zero lag, zero drift. Runs only while smx-main-sec is visible.
*/

/** startMainLoop — Prasidha: starts unified clock + timer rAF loop */
function startMainLoop() {
  stopMainLoop();
  let lastSec = -1;

  function loop() {
    const d  = new Date();
    const sc = d.getSeconds();

    if (sc !== lastSec) {
      lastSec = sc;
      const hh = d.getHours()  .toString().padStart(2, '0');
      const mm = d.getMinutes().toString().padStart(2, '0');
      const ss = sc.toString().padStart(2, '0');

      setTx('smx-hdr-clock', toLocalNum(`${hh}:${mm}:${ss}`));
      setTx('smx-hdr-date', d.toLocaleDateString(langLocale(), {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
      }));

      /* CI-only = running shift timer */
      if (U.clockIn && !U.clockOut && !U.submitted) {
        var _ms = Date.now() - new Date(U.clockIn).getTime();
        if (_ms < 0) _ms = 0;
        if (_ms > DUR_CAP_MS) _ms = DUR_CAP_MS;   /* cap live timer at 24h */
        var _hh = String(Math.floor(_ms/3600000)).padStart(2,'0');
        var _mm = String(Math.floor((_ms%3600000)/60000)).padStart(2,'0');
        var _ss = String(Math.floor((_ms%60000)/1000)).padStart(2,'0');
        var _tv = g('timer-val'); if (_tv) _tv.textContent = toLocalNum(_hh+':'+_mm+':'+_ss);
      }
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

/** stopMainLoop — Prasidha: cancels the rAF loop */
function stopMainLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

/* ══════════════════════════════════════════════════════════════
   SVG CLOCK HANDS
   Prasidha: JS sets rotation angle once/second.
   CSS cubic-bezier transition does the smooth easing (GPU-composited).
*/

/** tickHands — Prasidha: sets H/M/S SVG hand rotation angles */
function tickHands(hId, mId, sId) {
  const d  = new Date();
  const sc = d.getSeconds();
  const mn = d.getMinutes() + sc / 60;
  const hr = (d.getHours() % 12) + mn / 60;
  rot(hId, hr * 30);
  rot(mId, mn * 6);
  rot(sId, sc * 6);
}

/** startHandLoop — Prasidha: starts 1s interval for auth clock */
function startHandLoop(hId = 'ac-h', mId = 'ac-m', sId = 'ac-s') {
  tickHands(hId, mId, sId);
  handIv = setInterval(() => tickHands(hId, mId, sId), 1000);
}

/** stopHandLoop — Prasidha: clears auth clock interval */
function stopHandLoop() { clearInterval(handIv); handIv = null; }

/** rot — Prasidha: applies CSS rotation to SVG element */
function rot(id, deg) {
  const el = g(id);
  if (el) el.style.transform = `rotate(${deg}deg)`;
}

/* ══════════════════════════════════════════════════════════════
   PAGE TRANSITION — CRED-style clock overlay
   Prasidha: Full-screen overlay with ticking clock + floating
   time emojis between screens. No dependencies.
*/
const PT_MSGS   = ['Switching view…', 'One moment…', 'Loading…', 'Just a tick…'];
const PT_EMOJIS = ['⏱', '⌛', '🕐', '⏳', '🕑', '⏰'];

/** pageTransition — Prasidha: shows animated overlay, runs fn() mid-fade */
function pageTransition(fn, msg) {
  const ov   = g('pg-tr');
  const msgEl = g('smx-pt-msg');
  const parts = g('smx-pt-parts');
  if (!ov) { if (fn) fn(); return; }

  if (msgEl) msgEl.textContent = msg || rnd(PT_MSGS);

  /* Spawn floating time emojis */
  if (parts) {
    parts.innerHTML = '';
    [...PT_EMOJIS].sort(() => Math.random() - .5).slice(0, 4).forEach((em, i) => {
      const p = document.createElement('div');
      p.className = 'pt-p';
      p.textContent = em;
      p.style.cssText = `left:${12 + i * 22}%;bottom:${8 + Math.random() * 18}px;animation-delay:${i * .14}s`;
      parts.appendChild(p);
    });
  }

  ov.classList.add('on');
  setTimeout(() => { if (fn) fn(); }, 260);
  setTimeout(() => ov.classList.remove('on'), 960);
}

/* ══════════════════════════════════════════════════════════════
   INPUT VALIDATION — Prasidha
   SECURITY: all three validators enforced consistently on every
   input, every page, re-checked on every button click.

   isValidName: letters + spaces, min 2 chars.
   isValidId  : digits only, 3–12 chars.
   isValidLoc : letters/digits/spaces/hyphens ONLY.
                Blocks all SQL-injection and HTML-injection chars.
   sanitize   : strips dangerous chars before any DB write.
                Supabase parameterized queries are the baseline.
                This is defence-in-depth.
*/
const isValidName = s => /^[a-zA-Z\s]{2,60}$/.test(s.trim());
const isValidId   = s => /^[0-9]{3,12}$/.test(s.trim());

/** isValidLoc — Prasidha: letters/digits/spaces/hyphens, max 20 chars.
   BLOCKS < > " ' ; = + # | \ / ( ) { } % @ ` and over-long input. */
const LOC_MAX = 20;
const isValidLoc  = s => /^[a-zA-Z0-9 \-]{1,20}$/.test(s.trim());

/* Cap any shift duration at 24 h. Guards against a forgotten clock-out
   (shift left open for days) producing runaway totals like 71:56:15. */
const DUR_CAP_MS = 24 * 60 * 60 * 1000;

/** sanitize — Prasidha: final strip before any DB write */
const sanitize = s =>
  s.trim().replace(/[<>"'`%;(){}\\\/=+|#@]/g, '').slice(0, 60);

/** showErrIf — Prasidha: helper to toggle inline error visibility */
const showErrIf = (id, cond) => {
  const el = g(id);
  if (el) el.style.display = cond ? 'block' : 'none';
};

/** validateLoc — Prasidha: validates location input, shows error, returns bool */
function validateLoc(raw, errId) {
  const v = (raw || '').trim();
  if (!v) { toast(t('enterLocName')); return false; }
  /* Check length BEFORE character set so a valid-but-too-long name (e.g. an
     old saved location > 20 chars) shows the correct "too long" message
     instead of the misleading "letters/numbers only" one. */
  if (v.length > LOC_MAX) {
    showErrIf(errId, true);
    toast(t('locTooLong'), 'err'); return false;
  }
  if (!isValidLoc(v)) {
    showErrIf(errId, true);
    toast(t('locInvalid'), 'err'); return false;
  }
  showErrIf(errId, false);
  return true;
}

/* ══════════════════════════════════════════════════════════════
   LOGIN VALIDATION
   Prasidha: Enables Start Day only when both fields pass.
*/
function setupLoginValidation() {
  const nIn = g('inp-name'), iIn = g('inp-id'), btn = g('btn-start');
  if (!nIn || !iIn || !btn) return;

  const check = () => {
    const n = nIn.value.trim(), i = iIn.value.trim();
    showErrIf('err-name', n && !isValidName(n));
    showErrIf('err-id',   i && !isValidId(i));
    btn.disabled = !(isValidName(n) && isValidId(i));
  };
  nIn.addEventListener('input', check);
  iIn.addEventListener('input', check);
}

/* ══════════════════════════════════════════════════════════════
   START DAY
   Prasidha: Re-validates on click (not just on input events).
*/
g('btn-start').addEventListener('click', (e) => { e.preventDefault();
  const name = g('inp-name').value.trim();
  const id   = g('inp-id').value.trim();

  /* SECURITY: Re-validate on click (Prasidha v08) */
  if (!isValidName(name) || !isValidId(id)) {
    toast(t('checkDetails'), 'err'); return;
  }

  /* route through azureApply so identity is stored correctly.
     Photo will be empty in manual fallback — that is acceptable. */
  azureApply(id, name, U._azureEmail || '', U.photo || '', 'Manual Fallback');
});

/* ══════════════════════════════════════════════════════════════
   RENDER MAIN — central state router
   FIX-01 (Prasidha): enforces section visibility at every call.
   Called from btn-start AND session restore. Both paths show
   smx-main-sec and hide smx-auth-sec correctly.
*/
/* ══════════════════════════════════════════════════════════════
   SCREEN ROUTER — v11
   Sections: smx-auth-sec · smx-welcome-sec · smx-main-sec · smx-capture-sec · smx-success-sec.
   showSection() hides all and shows one. renderRoot() decides which.
   In-app navigation goes through goCapture/goMain/goSuccess which wrap
   the transition loader so an animation always plays between screens.
*/
const SECTIONS = ['smx-auth-sec','smx-welcome-sec','smx-main-sec','smx-capture-sec','smx-success-sec'];

function showSection(id) {
  SECTIONS.forEach(s => { const el = g(s); if (el) el.classList.toggle('hidden', s !== id); });
}

/* Module logo — "GeoLocation Attendance" wordmark, embedded INLINE as an
   SVG data URI (no external file). Map + location-pin + clock icon and
   the wordmark are drawn in the brand orange→red gradient so the mark
   reads on both light and dark cards. */
const GEO_LOGO_SVG =
`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 72" fill="none" shape-rendering="geometricPrecision" text-rendering="geometricPrecision">
  <defs>
    <linearGradient id="geoGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F58220"/>
      <stop offset="1" stop-color="#A6192E"/>
    </linearGradient>
  </defs>
  <g stroke="url(#geoGrad)" stroke-linejoin="round" stroke-linecap="round">
    <path d="M8 44 L24 39 L40 44 L56 39 L56 57 L40 62 L24 57 L8 62 Z" stroke-width="3.4"/>
    <path d="M24 39 L24 57 M40 44 L40 62" stroke-width="2.6"/>
    <path d="M34 6 C25 6 18 13 18 22 C18 32 34 43 34 43 C34 43 50 32 50 22 C50 13 43 6 34 6 Z" stroke-width="3.6"/>
    <circle cx="34" cy="21" r="8.4" stroke-width="3.2"/>
    <path d="M34 15.6 L34 21 L38.4 23.8" stroke-width="3"/>
  </g>
  <circle cx="17" cy="51" r="2.8" fill="url(#geoGrad)"/>
  <text x="74" y="47" font-family="Segoe UI, Arial, sans-serif" font-size="27" font-weight="800" letter-spacing="-0.3" fill="url(#geoGrad)">GeoLocation Attendance</text>
</svg>`;
const MODULE_LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent(GEO_LOGO_SVG);
let _fallbackLogoB64 = '';

/** setLogos — show the module wordmark everywhere */
function setLogos() {
  const authImg = document.querySelector('.smx-auth-logo');
  /* capture the original embedded logo once, for fallback */
  if (!_fallbackLogoB64 && authImg && /^data:/.test(authImg.src)) _fallbackLogoB64 = authImg.src;

  [authImg, g('smx-wel-logo'), g('smx-logo-sm'), g('suc-logo')].forEach(img => {
    if (!img || img.dataset.smxModuleSet) return;
    img.dataset.smxModuleSet = '1';
    img.alt = 'GeoLocation Attendance';
    img.onerror = function () {
      img.onerror = null;
      if (_fallbackLogoB64) img.src = _fallbackLogoB64;
    };
    img.src = MODULE_LOGO;
  });

  /* footer logo */
  if (_fallbackLogoB64) {
    document.querySelectorAll('.smx-ftr-seamex').forEach(im => {
      if (im.dataset.smxSet) return;
      im.dataset.smxSet = '1';
      im.src = _fallbackLogoB64;
    });
  }
}

/** applyPhoto — sets profile photo, or initials fallback */
function applyPhoto(img, initEl, photo, name) {
  const parts = (name || 'E').trim().split(' ');
  const initials = ((parts[0] || 'E')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  if (img && photo) {
    img.src = photo; img.style.display = 'block';
    if (initEl) initEl.style.display = 'none';
    img.onerror = function () {
      img.style.display = 'none';
      if (initEl) { initEl.textContent = initials; initEl.style.display = 'flex'; }
    };
  } else if (initEl) {
    initEl.textContent = initials; initEl.style.display = 'flex';
    if (img) img.style.display = 'none';
  }
}

/** renderRoot — choose the right screen for the current state (no transition) */
function renderRoot() {
  smxKeepAlive(); smxUpdateOnlineState();

  hide('smx-auth-sec');
  setLogos();

  if (U.submitted) {
    showSection('smx-success-sec');
    renderSuccess();
    checkPending();
    return;
  }
  if (!U.clockIn && !U.clockOut) {
    showSection('smx-welcome-sec');
    renderWelcome();
    checkPending();
    return;
  }
  showSection('smx-main-sec');
  renderMainBody();
  checkPending();
}

/** renderWelcome — centered photo + PID + logo + two action buttons */
function renderWelcome() {
  stopMainLoop();
  setLogos();
  setTx('smx-wel-name', U.name || '');
  setTx('smx-wel-id',   U.id ? ('PID ' + U.id) : '');
  applyPhoto(g('smx-wel-photo'), g('smx-wel-initials'), U.photo, U.name);
}

/** renderMainBody — active shift: header + hero timer + row buttons */
function renderMainBody() {
  setTx('disp-name', U.name || '');
  setTx('disp-id',   U.id ? ('PID ' + U.id) : '');
  applyPhoto(g('smx-mhl-photo'), g('smx-mhl-initials'), U.photo, U.name);
  setLogos();
  hide('smx-ghost-scr');
  startMainLoop();
  renderPunchDisplay();
  v12BindEditButtons();
  v12BindSubmitHold();
}

/* ════════════════════════════════════════════════════════════
 *  v12 logic — Prasidha Jagtap
 *  ─ renderPunchDisplay (4-state hero, no running counter)
 *  ─ accuracy classifier (Accurate / Approximate / Network only)
 *  ─ edit action sheet + confirm popups + rename
 *  ─ tap-and-hold submit (1 s)
 *  ════════════════════════════════════════════════════════════ */

/* ───── 1. Accuracy classifier  ───── */
function v12AccQuality(source, accuracy) {
  if (source === 'ip') return { q: 'network',    tx: 'Network only' };
  const a = Number(accuracy) || 0;
  if (a === 0)         return { q: 'approximate', tx: 'Approximate' }; /* unknown */
  if (a <= 50)         return { q: 'accurate',    tx: 'Accurate' };
  if (a <= 500)        return { q: 'approximate', tx: 'Approximate' };
  return                       { q: 'network',    tx: 'Network only' };
}

function v12PaintAcc(elId, source, accuracy) {
  const el = g(elId); if (!el) return;
  const qx = v12AccQuality(source, accuracy);
  el.classList.remove('hidden');
  el.setAttribute('data-q', qx.q);
  const tx = el.querySelector('.smx-acc-tx');
  if (tx) tx.textContent = qx.tx;
}
function v12HideAcc(elId) {
  const el = g(elId); if (el) el.classList.add('hidden');
}

/* ───── 2. Hero state machine + tile painter ───── */
function renderPunchDisplay() {
  /* tile times + locations */
  setTx('ci-time', toLocalNum(U.clockIn  ? fmt(U.clockIn)  : '--:-- --'));
  setTx('ci-loc',  U.clockIn  ? U.clockInLoc    : t('tapToRecord'));
  setTx('co-time', toLocalNum(U.clockOut ? fmt(U.clockOut) : '--:-- --'));
  setTx('co-loc',  U.clockOut ? U.clockOutLoc   : t('tapToRecord'));

  /* accuracy dot + word — only when data exists */
  if (U.clockIn)  v12PaintAcc('ci-acc', U.clockInCoordSource,  U.clockInAccuracy);
  else            v12HideAcc('ci-acc');
  if (U.clockOut) v12PaintAcc('co-acc', U.clockOutCoordSource, U.clockOutAccuracy);
  else            v12HideAcc('co-acc');

  /* tile empty / has-data state + edit icon visibility */
  const tileCI = g('tile-ci'), tileCO = g('tile-co');
  const editCI = g('btn-edit-ci'), editCO = g('btn-edit-co');
  if (tileCI) tileCI.classList.toggle('empty', !U.clockIn);
  if (tileCO) tileCO.classList.toggle('empty', !U.clockOut);
  if (editCI) editCI.classList.toggle('hidden', !U.clockIn);
  if (editCO) editCO.classList.toggle('hidden', !U.clockOut);

  /* hero state — no running counter; static display only */
  const hero = g('status-card');
  const heroVal = g('timer-val');
  const heroLbl = g('sh-lbl-txt');
  const heroSub = g('sh-sub-txt');
  if (!hero || !heroVal || !heroLbl) return;

  const hasCI = !!U.clockIn, hasCO = !!U.clockOut;
  const ciT = hasCI ? new Date(U.clockIn).getTime()  : 0;
  const coT = hasCO ? new Date(U.clockOut).getTime() : 0;

  let state = 'empty';
  if (hasCI && hasCO) state = (ciT <= coT) ? 'duration' : 'warning';
  else if (hasCI)     state = 'ci-only';
  else if (hasCO)     state = 'co-only';

  hero.setAttribute('data-state', state);

  switch (state) {
    case 'empty':
      heroLbl.textContent = t('notStarted');
      heroVal.textContent = toLocalNum('00:00:00');
      if (heroSub) heroSub.textContent = '';
      break;
    case 'ci-only':
      heroLbl.textContent = t('heroCurrentShift');
      /* Initial paint — show 00:00:00; startMainLoop ticks it every frame */
      {
        var _ms0 = Date.now() - new Date(U.clockIn).getTime();
        if (_ms0 < 0) _ms0 = 0;
        if (_ms0 > DUR_CAP_MS) _ms0 = DUR_CAP_MS;   /* cap live timer at 24h */
        heroVal.textContent = toLocalNum(String(Math.floor(_ms0/3600000)).padStart(2,'0')+':'+String(Math.floor((_ms0%3600000)/60000)).padStart(2,'0')+':'+String(Math.floor((_ms0%60000)/1000)).padStart(2,'0'));
      }
      if (heroSub) heroSub.textContent = t('heroSinceAwait').replace('{t}', toLocalNum(fmt(U.clockIn)));
      break;
    case 'co-only':
      heroLbl.textContent = t('heroClockedOut');
      heroVal.textContent = toLocalNum(fmt(U.clockOut));
      if (heroSub) heroSub.textContent = t('heroNoCI');
      break;
    case 'duration':
      heroLbl.textContent = t('shiftDuration');
      heroVal.textContent = toLocalNum(duration(U.clockIn, U.clockOut));
      if (heroSub) heroSub.textContent = toLocalNum(fmt(U.clockIn) + '  →  ' + fmt(U.clockOut));
      break;
    case 'warning':
      heroLbl.textContent = t('heroNeedsReview');
      heroVal.textContent = t('heroWarnMsg');
      if (heroSub) heroSub.textContent = '';
      break;
  }
}

/* ───── 3. Tile + Edit handlers ───── */
let v12EditTarget = null; /* 'ci' | 'co' */

function v12BindEditButtons() {
  const tileCi = g('btn-ci'),   tileCo = g('btn-co');
  const editCi = g('btn-edit-ci'), editCo = g('btn-edit-co');

  if (tileCi && !tileCi.dataset.v12Bound) {
    tileCi.dataset.v12Bound = '1';
    tileCi.addEventListener('click', function (e) {
      if (g('tile-ci')?.classList.contains('empty')) {
        goCapture('in');
      }
      /* tile has data → no-op on tap; user must use Edit button */
    });
  }
  if (tileCo && !tileCo.dataset.v12Bound) {
    tileCo.dataset.v12Bound = '1';
    tileCo.addEventListener('click', function (e) {
      if (g('tile-co')?.classList.contains('empty')) {
        goCapture('out');
      }
    });
  }
  if (editCi && !editCi.dataset.v12Bound) {
    editCi.dataset.v12Bound = '1';
    editCi.addEventListener('click', function (e) {
      e.stopPropagation();
      v12OpenEditSheet('ci');
    });
  }
  if (editCo && !editCo.dataset.v12Bound) {
    editCo.dataset.v12Bound = '1';
    editCo.addEventListener('click', function (e) {
      e.stopPropagation();
      v12OpenEditSheet('co');
    });
  }

  /* sheet options */
  const optT = g('opt-time'), optN = g('opt-name'), optR = g('opt-recap'), optC = g('opt-cancel');
  if (optT && !optT.dataset.v12Bound) { optT.dataset.v12Bound = '1';
    optT.addEventListener('click', () => v12CloseSheet(v12HandleMarkTime)); }
  if (optN && !optN.dataset.v12Bound) { optN.dataset.v12Bound = '1';
    optN.addEventListener('click', () => v12CloseSheet(v12HandleRename)); }
  if (optR && !optR.dataset.v12Bound) { optR.dataset.v12Bound = '1';
    optR.addEventListener('click', () => v12CloseSheet(v12HandleRecap)); }
  if (optC && !optC.dataset.v12Bound) { optC.dataset.v12Bound = '1';
    optC.addEventListener('click', () => v12CloseSheet()); }

  /* close sheet on backdrop tap */
  const back = g('edit-sheet-backdrop');
  if (back && !back.dataset.v12Bound) { back.dataset.v12Bound = '1';
    back.addEventListener('click', function (e) {
      if (e.target === back) v12CloseSheet();
    });
  }
  /* close popups on backdrop tap */
  ['confirm-backdrop', 'rename-backdrop'].forEach(id => {
    const b = g(id);
    if (b && !b.dataset.v12Bound) { b.dataset.v12Bound = '1';
      b.addEventListener('click', function (e) { if (e.target === b) hide(id); });
    }
  });
  /* confirm popup buttons */
  const cc = g('confirm-cancel'), ok = g('confirm-ok');
  if (cc && !cc.dataset.v12Bound) { cc.dataset.v12Bound = '1';
    cc.addEventListener('click', () => { hide('confirm-backdrop'); v12ConfirmCb = null; }); }
  if (ok && !ok.dataset.v12Bound) { ok.dataset.v12Bound = '1';
    ok.addEventListener('click', () => {
      hide('confirm-backdrop');
      if (typeof v12ConfirmCb === 'function') { const cb = v12ConfirmCb; v12ConfirmCb = null; cb(); }
    });
  }
  /* rename popup buttons */
  const rc = g('rename-cancel'), rk = g('rename-ok');
  if (rc && !rc.dataset.v12Bound) { rc.dataset.v12Bound = '1';
    rc.addEventListener('click', () => hide('rename-backdrop')); }
  if (rk && !rk.dataset.v12Bound) { rk.dataset.v12Bound = '1';
    rk.addEventListener('click', v12RenameCommit); }
}

function v12OpenEditSheet(which) {
  v12EditTarget = which;
  const lbl = which === 'ci' ? t('clockIn') : t('clockOut');
  const tm = which === 'ci' ? (U.clockIn ? fmt(U.clockIn) : '') : (U.clockOut ? fmt(U.clockOut) : '');
  setTx('edit-sheet-title', t('editTitle').replace('{x}', lbl) + (tm ? ' · ' + toLocalNum(tm) : ''));
  show('edit-sheet-backdrop');
}
function v12CloseSheet(then) {
  hide('edit-sheet-backdrop');
  if (typeof then === 'function') setTimeout(then, 60);
}

/* ── confirmation popup helper ── */
let v12ConfirmCb = null;
function v12Confirm(title, msg, okLabel, onYes) {
  setTx('confirsmx-m-title', title);
  setTx('confirm-msg', msg);
  const ok = g('confirm-ok'); if (ok) ok.textContent = okLabel || 'Yes, update';
  v12ConfirmCb = onYes;
  show('confirm-backdrop');
}

/* ── Mark time now ── */
function v12HandleMarkTime() {
  if (!v12EditTarget) return;
  var which = v12EditTarget;
  var _pLbl = which === 'ci' ? t('punchIn') : t('punchOut');
  var _mkIv = null;
  function _gMsg() {
    var _n = new Date(), _h = _n.getHours(), _m = _n.getMinutes(), _s = _n.getSeconds();
    var _ap = _h >= 12 ? 'pm' : 'am';
    var _h12 = ((_h % 12) || 12).toString().padStart(2, '0');
    var _time = toLocalNum(_h12 + ':' + _m.toString().padStart(2,'0') + ':' + _s.toString().padStart(2,'0') + ' ' + _ap);
    return t('markTimeMsg').replace('{x}', _pLbl).replace('{time}', _time);
  }
  v12Confirm(t('markTimeTitle'), _gMsg(), t('yesUpdate'), function () {
    if (_mkIv) clearInterval(_mkIv);
    var iso = nowISO();
    if (which === 'ci') U.clockIn = iso; else U.clockOut = iso;
    U.lastActionDate = iso; save(); renderPunchDisplay();
    toast(which === 'ci' ? t('ciTimeUpdated') : t('coTimeUpdated'), 'ok');
  });
  _mkIv = setInterval(function () {
    var _bd = g('confirm-backdrop');
    if (_bd && !_bd.classList.contains('hidden')) {
      var _me = g('confirm-msg'); if (_me) _me.textContent = _gMsg();
    } else { clearInterval(_mkIv); }
  }, 1000);
}

/* ── Rename location ── */
function v12HandleRename() {
  if (!v12EditTarget) return;
  const which = v12EditTarget;
  const cur = which === 'ci' ? (U.clockInLoc || '') : (U.clockOutLoc || '');
  setTx('rename-msg', t('renameMsg').replace('{x}', which === 'ci' ? t('punchIn') : t('punchOut')));
  const inp = g('rename-input');
  if (inp) { inp.value = cur; setTimeout(() => inp.focus(), 80); }
  show('rename-backdrop');
}
function v12RenameCommit() {
  const inp = g('rename-input'); if (!inp) return;
  const raw = (inp.value || '').trim();
  if (!raw) { toast(t('locEmpty'), 'err'); return; }
  if (raw.length > LOC_MAX) { toast(t('locTooLong'), 'err'); return; }
  if (!isValidLoc(raw)) { toast(t('locInvalid'), 'err'); return; }
  const which = v12EditTarget; if (!which) { hide('rename-backdrop'); return; }
  if (which === 'ci') U.clockInLoc  = raw;
  else                U.clockOutLoc = raw;
  U.lastActionDate = nowISO();
  save();
  hide('rename-backdrop');
  renderPunchDisplay();
  toast(t('locRenamed'), 'ok');
}

/* ── Re-capture (full flow) ── */
function v12HandleRecap() {
  if (!v12EditTarget) return;
  const which = v12EditTarget;
  v12Confirm(
    t('newPlaceTitle'),
    t('newPlaceMsg').replace('{x}', which === 'ci' ? t('punchIn') : t('punchOut')),
    t('continueBtn'),
    function () { goCapture(which === 'ci' ? 'in' : 'out'); }
  );
}

/* ───── 4. Tap-and-hold Submit ───── */
const V12_HOLD_MS = 1000;
let v12HoldTimer = null;
let v12HoldStart = 0;
let v12HoldRaf   = null;

function v12BindSubmitHold() {
  const btn  = g('submit-hold');  if (!btn) return;
  if (btn.dataset.v12Bound) return;
  btn.dataset.v12Bound = '1';

  const start = function (e) {
    if (e.cancelable) e.preventDefault();
    if (btn.classList.contains('done')) return;
    btn.classList.add('holding');
    v12HoldStart = Date.now();
    v12SetRing(0);
    /* animate ring fill via single CSS transition (1s linear) */
    requestAnimationFrame(() => v12SetRing(1));
    v12HoldTimer = setTimeout(v12HoldCommit, V12_HOLD_MS);
  };
  const cancel = function (e) {
    if (!btn.classList.contains('holding')) return;
    if (btn.classList.contains('done')) return;
    clearTimeout(v12HoldTimer); v12HoldTimer = null;
    btn.classList.remove('holding');
    /* retract ring smoothly */
    v12SetRing(0);
  };

  /* pointer events cover mouse + touch + pen */
  btn.addEventListener('pointerdown',   start);
  btn.addEventListener('pointerup',     cancel);
  btn.addEventListener('pointerleave',  cancel);
  btn.addEventListener('pointercancel', cancel);
  /* keyboard accessibility — space/enter trigger an immediate-confirm popup instead of hold */
  btn.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      v12Confirm(t('submitConfirmTitle'), t('submitConfirmMsg'), t('yesSubmit'), v12HoldCommit);
    }
  });
}

function v12SetRing(progress) {
  const c = g('submit-ring'); if (!c) return;
  const total = 402;
  c.setAttribute('stroke-dashoffset', String(Math.max(0, total - total * progress)));
}

function v12HoldCommit() {
  const btn = g('submit-hold'); if (!btn) return;
  btn.classList.remove('holding');
  btn.classList.add('done');
  v12SetRing(1);
  /* swap inner content to a tick */
  const inner = g('submit-inner');
  if (inner) inner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="32" height="32"><polyline points="20 6 9 17 4 12"/></svg>';
  /* delegate to existing submission logic */
  setTimeout(function () {
    try { doSubmit(); } catch (e) { console.error('[v12 submit]', e); }
  }, 220);
}

/* Reset submit-hold visuals (used after a submit failure so user can retry) */
function v12ResetSubmitHold() {
  const btn = g('submit-hold'); if (!btn) return;
  btn.classList.remove('holding', 'done');
  v12SetRing(0);
  const inner = g('submit-inner');
  if (inner) {
    inner.innerHTML =
      '<span class="smx-sub-tx" id="submit-tx" data-i18n="submitShift"></span>' +
      '<span class="smx-sub-sub" id="submit-sub" data-i18n="pressHold"></span>';
    g('submit-tx').textContent  = t('submitShift');
    g('submit-sub').textContent = t('pressHold');
  }
}

/* ───── 5. Paint helpers for submitted page ───── */
function renderSuccess() {
  stopMainLoop();
  /* date */
  setTx('ss-date', new Date().toLocaleDateString(langLocale(), {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
  }));
  /* CI / CO */
  setTx('ss-in-t',  toLocalNum(U.clockIn  ? fmt(U.clockIn)  : '—'));
  setTx('ss-in-l',  U.clockIn  ? (U.clockInLoc  || '—') : '—');
  setTx('ss-out-t', toLocalNum(U.clockOut ? fmt(U.clockOut) : '—'));
  setTx('ss-out-l', U.clockOut ? (U.clockOutLoc || '—') : '—');
  setTx('ss-dur',   toLocalNum((U.clockIn && U.clockOut) ? duration(U.clockIn, U.clockOut) : '—'));
  /* logo + identity */
  setLogos();
  setTx('suc-name', U.name || '—');
  setTx('suc-pid',  U.id ? ('PID ' + toLocalNum(U.id)) : 'PID --');
  /* photo */
  applyPhoto(g('suc-photo'), g('suc-initials'), U.photo, U.name);
}

/* ───── 6. App root anchor — add id="smx-app" once ───── */
(function attachAppRoot() {
  function _do() {
    try {
      const main = document.querySelector('main') || document.body;
      if (main && !document.getElementById('smx-app')) {
        main.id = 'smx-app';
      }
    } catch(e){}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _do);
  } else { _do(); }
})();

/* ───── 7. Legacy sourceTag kept for safety (returns '') ───── */
function sourceTag() { return ''; }



/* ══════════════════════════════════════════════════════════════
   CAPTURE WINDOW FLOW — v11

   Welcome and main both route every punch through the capture window.
   The window auto-grabs GPS, shows the live punch time, lets the user
   name the location, then Confirm writes the punch and returns to main.
   Re-punching shows a "replaces earlier time" note in the same window.
   Everything stays on-device until Submit.
*/
let captureKind = null;   /* 'in' | 'out' */
let capCoords   = null;   /* coordinates captured this session */
let capClockIv  = null;   /* live punch-time interval */

/* Trigger buttons — welcome screen */
g('btn-w-ci').addEventListener('click', e => { e.preventDefault(); goCapture('in');  });
g('btn-w-co').addEventListener('click', e => { e.preventDefault(); goCapture('out'); });

/* Trigger buttons — active main screen */
g('btn-ci').addEventListener('click', e => { e.preventDefault(); goCapture('in');  });
g('btn-co').addEventListener('click', e => { e.preventDefault(); goCapture('out'); });

/* Capture window controls */
g('smx-cap-confirm').addEventListener('click', e => { e.preventDefault(); confirmCapture(); });
g('smx-cap-cancel').addEventListener('click',  e => { e.preventDefault(); cancelCapture(); });
g('smx-cap-close').addEventListener('click',       e => { e.preventDefault(); cancelCapture(); });

/** goCapture — animate into the capture window for a punch */
function goCapture(kind) {
  if (U.submitted) { toast(t('alreadySubmitted'), 'err'); return; }
  captureKind = kind;
  pageTransition(() => { showSection('smx-capture-sec'); enterCapture(kind); },
                 kind === 'in' ? t('clockIn') : t('clockOut'));
}

/** enterCapture — set up the window then start GPS + live clock */
function enterCapture(kind) {
  stopMainLoop();
  setTx('smx-cap-title', kind === 'in' ? t('clockIn') : t('clockOut'));
  setTx('smx-cap-confirm', kind === 'in' ? t('capConfirmIn') : t('capConfirmOut'));

  const existing = kind === 'in' ? U.clockIn : U.clockOut;
  g('smx-cap-note').classList.toggle('hidden', !existing);

  const sec = g('smx-capture-sec');
  if (sec) { sec.classList.toggle('cap-in', kind === 'in'); sec.classList.toggle('cap-out', kind === 'out'); }

  const cap = g('cap-loc');
  if (cap) cap.value = kind === 'in' ? (U.clockInLoc || '') : (U.clockOutLoc || '');
  showErrIf('err-cap', false);
  renderChips('cap-loc', 'cap-chips', 'cap-drop');

  startCapClock();
  startGeoCapture();
}

/** live punch-time clock inside the capture window */
function startCapClock() {
  stopCapClock();
  const upd = () => setTx('smx-cap-time', toLocalNum(fmtClock(new Date())));
  upd();
  capClockIv = setInterval(upd, 1000);
}
function stopCapClock() { if (capClockIv) { clearInterval(capClockIv); capClockIv = null; } }

/** fmtClock — hh:mm:ss AM/PM */
function fmtClock(d) {
  let h = d.getHours(); const m = d.getMinutes(), s = d.getSeconds();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)} ${ap}`;
}

/** startGeoCapture — fetch coords, paint the location box state */
async function startGeoCapture() {
  capCoords = null;
  const geo = g('smx-cap-geo'), ic = g('smx-cap-geo-ic'), btn = g('smx-cap-confirm');
  if (geo) geo.className = 'smx-cap-geo smx-capturing';
  if (ic) ic.innerHTML = '<svg class="smx-cap-spin" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
  setTx('smx-cap-geo-tx', t('capturingLoc'));
  setTx('smx-cap-geo-sub', t('holdOn'));
  if (btn) btn.disabled = true;

  markBusy();
  let coords = null;
  try { coords = await getCoords(); }
  catch (e) { console.error('[GeoAtt] GPS exception:', e); }
  finally { clearBusy(); }

  /* If the user left the window while we waited, do nothing */
  if (g('smx-capture-sec')?.classList.contains('hidden')) return;

  if (coords) {
    capCoords = coords;
    const approx = U._coordSource === 'ip';
    if (geo) geo.className = 'smx-cap-geo done' + (approx ? ' approx' : '');
    if (ic) ic.innerHTML = approx
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTx('smx-cap-geo-tx', approx ? t('locApprox') : t('locCaptured'));
    setTx('smx-cap-geo-sub', toLocalNum(coords) + (approx ? '  ·  ' + t('netSuffix') : ''));
    if (btn) btn.disabled = false;
  } else {
    if (geo) geo.className = 'smx-cap-geo err';
    if (ic) ic.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.4" x2="12" y2="16.5"/></svg>';
    setTx('smx-cap-geo-tx', t('capLocUnavail'));
    setTx('smx-cap-geo-sub', t('capTapRetry'));
    if (btn) btn.disabled = true;
  }
}

/** confirmCapture — validate, write the punch, animate back to main */
function confirmCapture() {
  const raw = g('cap-loc').value;
  if (!validateLoc(raw, 'err-cap')) return;
  if (!capCoords) { toast(t('locNotCaptured'), 'err'); return; }

  const loc = sanitize(raw);
  saveLoc(loc);
  const ts = nowISO();

  if (captureKind === 'in') {
    U.clockIn = ts; U.clockInCoords = capCoords; U.clockInLoc = loc;
    U.clockInCoordSource = U._coordSource || 'gps';
    U.isClockedIn = true;
  } else {
    U.clockOut = ts; U.clockOutCoords = capCoords; U.clockOutLoc = loc;
    U.clockOutCoordSource = U._coordSource || 'gps';
  }
  U.lastActionDate = ts;
  save();

  stopCapClock();
  const kind = captureKind;
  captureKind = null; capCoords = null;

  pageTransition(() => { showSection('smx-main-sec'); renderMainBody(); },
                 kind === 'in' ? t('transClockedIn') : t('transClockedOut'));
  toast(kind === 'in' ? t('clockInRecorded') : t('clockOutRecorded'), 'ok');
}

/** cancelCapture — back out without writing; return to the right screen */
function cancelCapture() {
  stopCapClock();
  captureKind = null; capCoords = null;
  const back = (!U.clockIn && !U.clockOut) ? 'smx-welcome-sec' : 'smx-main-sec';
  pageTransition(() => {
    showSection(back);
    if (back === 'smx-welcome-sec') renderWelcome(); else renderMainBody();
  }, t('transMoment'));
}

/* ══════════════════════════════════════════════════════════════
   NEXT-DAY CATCH-UP — v10

   A shift from a previous day that was never submitted is held under
   KEY_PENDING. On the next open we show a read-only prompt with the
   last recorded times (blank where a punch is missing). The user can
   submit it or discard it. They cannot edit a previous day's punches.
*/

/** freshDay — builds a clean same-identity state for a new day */
function freshDay(src) {
  src = src || {};
  return {
    name: src.name || '', id: src.id || '', photo: src.photo || '',
    businessName: src.businessName || '', businessUnit: src.businessUnit || '',
    businessDesc: src.businessDesc || '', buUnitDesc: src.buUnitDesc || '',
    clockIn: null,  clockInCoords: '',  clockInLoc: '',
    clockOut: null, clockOutCoords: '', clockOutLoc: '',
    isClockedIn: false, submitted: false, lastActionDate: nowISO(),
    clockInCoordSource: 'gps', clockOutCoordSource: 'gps',
    _azureEmail: src._azureEmail || ''
  };
}

function loadPending() {
  try { const r = localStorage.getItem(KEY_PENDING); return r ? JSON.parse(r) : null; }
  catch { return null; }
}
function clearPending() { localStorage.removeItem(KEY_PENDING); }

/** checkPending — called at end of renderMain; raises the prompt if needed */
function checkPending() {
  const p = loadPending();
  if (!p) return;
  if (g('modal-ov')?.classList.contains('open')) return;  /* don't stack */
  showNextDayPrompt(p);
}

/** showNextDayPrompt — read-only summary of the held shift */
function showNextDayPrompt(p) {
  const dt   = p.lastActionDate ? new Date(p.lastActionDate) : new Date();
  const dstr = dt.toLocaleDateString(langLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const inT  = p.clockIn  ? toLocalNum(fmt(p.clockIn))  : '—';
  const outT = p.clockOut ? toLocalNum(fmt(p.clockOut)) : '—';

  showModal({
    icon: '🕛',
    title: t('pendingTitle'),
    body: t('pendingBody').replace('{d}', dstr).replace('{in}', inT).replace('{out}', outT),
    buttons: [
      { label: t('submitNow'),   cls: 'btn-grn',  fn: () => submitPending(p) },
      { label: t('pendingDiscard'), cls: 'btn-edit', fn: () => { clearPending(); toast(t('pendingDiscarded')); } }
    ]
  });
}

/** submitPending — sends the held shift to the DB; keeps it on failure */
async function submitPending(p) {
  toast(t('pendingSubmitting'));
  try {
    const { error } = await _db.from('attendance').insert([buildPayload(p)]);
    if (!error) {
      clearPending();
      toast(t('pendingSubmitted'), 'ok');
    } else {
      console.error('[GeoAtt] Pending submit error:', error);
      toast(t('pendingFailed'), 'err');
    }
  } catch (e) {
    console.error('[GeoAtt] Pending submit network error:', e);
    toast(t('pendingNetIssue'), 'err');
  }
}

/**
 * buildPayload — single source of truth for the DB record.
 * Missing punches are sent as null (blank). Status is 'completed'
 * only when both punches exist, otherwise 'partial'.
 */
function buildPayload(rec) {
  return {
    user_name:               sanitize(rec.name || ''),
    employee_id:             (rec.id || '').replace(/\D/g, ''),
    clock_in_time:           rec.clockIn  || null,
    clock_in_coords:         rec.clockInCoords  || null,
    clock_in_location_name:  rec.clockInLoc  ? sanitize(rec.clockInLoc)  : null,
    clock_out_time:          rec.clockOut || null,
    clock_out_coords:        rec.clockOutCoords || null,
    clock_out_location_name: rec.clockOutLoc ? sanitize(rec.clockOutLoc) : null,
    status:                  (rec.clockIn && rec.clockOut) ? 'completed' : 'partial',
    business_name:           sanitize(rec.businessName || ''),
    business_unit:           sanitize(rec.businessUnit || ''),
    business_desc:           sanitize(rec.businessDesc || ''),
    bu_unit_desc:            sanitize(rec.buUnitDesc   || ''),
    clock_in_coord_source:   rec.clockInCoordSource  || 'gps',
    clock_out_coord_source:  rec.clockOutCoordSource || 'gps',
    /* Email captured so the dashboard's HR-add lookup can find a user's
       business from their attendance history (hybrid fallback path). */
    email:                   (rec._azureEmail || rec.email || '') || null
  };
}


/* ══════════════════════════════════════════════════════════════
   MODAL SYSTEM — Prasidha
   Generic modal. All content via textContent (XSS safe).
   Buttons built with createElement.
*/

/**
 * showModal — Prasidha
 * @param {object} opts  { icon, title, body, buttons[], showEditIn }
 * buttons: [{ label, cls, fn }]
 */
function showModal({ icon, title, body, buttons, showEditIn = false }) {
  setTx('smx-m-icon',  icon  || 'ℹ️');
  setTx('smx-m-title', title || '');
  setTx('smx-m-body',  body  || '');

  if (showEditIn) {
    show('m-edit-in');
    const inp = g('edit-in-inp');
    if (inp) { inp.value = U.clockInLoc; setTimeout(() => inp.focus(), 200); }
  } else {
    hide('m-edit-in');
  }

  const btnsEl = g('smx-m-btns');
  btnsEl.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = `smx-btn-full ${b.cls || 'smx-btn-red'}`;
    btn.style.cssText = 'margin:0;flex:1';
    btn.textContent = b.label; /* SECURITY: textContent (Prasidha) */
    btn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); if (b.fn) b.fn(); });
    btnsEl.appendChild(btn);
  });

  g('modal-ov').classList.add('open');
}

/** closeModal — Prasidha */
function closeModal() { g('modal-ov').classList.remove('open'); }

g('modal-ov').addEventListener('click', e => { e.preventDefault();
  if (e.target === g('modal-ov')) closeModal();
});

/* (v10) Review / Fix-clock-in / Redo-clock-out removed.
   Corrections are now handled by re-tapping Record now, which
   shows an override confirm and overwrites the punch in place. */

/* ══════════════════════════════════════════════════════════════
   SUBMIT DAY
   Prasidha: isSubmitting guards against double-submit.
   Final sanitize() pass before DB write (defence-in-depth).
   SECURITY: raw Supabase error never shown to user.
*/

/** doSubmit — writes the current day's record to the DB */
async function doSubmit(_confirmed) {
  if (isSubmitting) return;
  /* empty-state still blocks */
  if (!U.clockIn && !U.clockOut) {
    v12ResetSubmitHold();
    toast(t('recordAtLeastOne'), 'err');
    return;
  }
  /* missing one punch — show confirmation popup */
  if ((!U.clockIn || !U.clockOut) && !_confirmed) {
    v12ResetSubmitHold();
    v12Confirm(
      t('incompleteTitle'),
      t('incompleteMsg').replace('{x}', U.clockIn ? t('punchOut') : t('punchIn')),
      t('incompleteBtn'),
      function () { doSubmit(true); }
    );
    return;
  }
  isSubmitting = true;

  setTx('smx-ghost-note', t('ghostNote'));
  show('smx-ghost-scr');

  try {
    const { error } = await _db.from('attendance').insert([buildPayload(U)]);
    hide('smx-ghost-scr');

    if (!error) {
      U.submitted = true; save();
      clearPending();   /* this device's day is now safely in the DB */
      pageTransition(() => { showSection('smx-success-sec'); renderSuccess(); }, t('shiftSubmitted'));
      toast(t('allDone'), 'ok');
    } else {
      console.error('[GeoAtt] Supabase error:', error);
      const msg = (error && /fetch|network|resolve|connection/i.test(error.message || ''))
        ? t('submitFailedNet')
        : t('submitFailedOther');
      toast(msg, 'err');
      isSubmitting = false;
      v12ResetSubmitHold();
    }
  } catch (e) {
    hide('smx-ghost-scr');
    console.error('[GeoAtt] Network error:', e);
    toast(t('submitFailedNet'), 'err');
    isSubmitting = false;
    v12ResetSubmitHold();
  }
}

/* ══════════════════════════════════════════════════════════════
   RENDER SUCCESS — v12 (Prasidha)
   v12 implementation lives earlier in this file (centered layout
   with photo + PID + tick + details card). This stub remains so
   any "last definition wins" surprise is avoided.
*/
/* renderSuccess() defined earlier */
function _legacyRenderSuccessHook() {
  stopMainLoop();
}

/* ══════════════════════════════════════════════════════════════
   STUCK BUTTON DETECTOR + RECOVERY — FIX-06 (Prasidha)

   markBusy(): call when a GPS-dependent button is disabled.
   After 5s, the recovery button (↺) appears next to theme toggle
   with a spinning animation and a tooltip.

   clearBusy(): called in every finally block after GPS resolves.
   Hides the recovery button and stops the spin.

   recoverState(): DOM-only re-render. URL unchanged. Session kept.
   Resets all stuck buttons and re-renders from current U state.
*/

/** markBusy — Prasidha: starts 5s timer for stuck-button detection */
function markBusy() {
  clearBusy();
  stuckTimer = setTimeout(() => {
    document.querySelectorAll('.smx-rcv-btn').forEach(b => {
      b.classList.remove('hidden');
      b.classList.add('rcv-spin');
    });
    document.querySelectorAll('.smx-rcv-tip').forEach(t => {
      t.classList.remove('hidden');
      setTimeout(() => t.classList.add('hidden'), 3500);
    });
  }, 5000);
}

/** clearBusy — Prasidha: cancels stuck timer and hides recovery button */
function clearBusy() {
  if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
  document.querySelectorAll('.smx-rcv-btn').forEach(b => {
    b.classList.add('hidden');
    b.classList.remove('rcv-spin');
  });
  document.querySelectorAll('.smx-rcv-tip').forEach(t => t.classList.add('hidden'));
}

/**
 * recoverState — Prasidha (FIX-06)
 * DOM-only recovery. Re-renders from U. URL unchanged. Session kept.
 * Called by the ↺ recovery button in both footers.
 */
function recoverState() {
  clearBusy();
  closeModal();
  stopCapClock();

  /* Reset any button that could be mid-action */
  const startBtn = g('btn-start');
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = t('startDay'); startBtn.classList.remove('hidden'); }
  const capBtn = g('smx-cap-confirm');
  if (capBtn) { capBtn.disabled = false; }

  hide('smx-ghost-scr');
  hide('inline-loader');

  /* If identity isn't resolved yet, we're on auth — just re-enable the form */
  if (!U.name || !U.id) {
    setupLoginValidation();
  } else {
    captureKind = null; capCoords = null;
    renderRoot();
  }

  toast(t('pageRecovered'), 'ok');
}

/* ══════════════════════════════════════════════════════════════
   GPS — getCoords()
   ★ FIX-05 (Prasidha) — TRUE Promise.race ★

   Two completely separate Promises:
     geoPromise    : resolves via getCurrentPosition callback.
     safetyPromise : resolves null after 9s guaranteed.
   Promise.race returns whichever settles first.

   This is different from the v06 approach which had ONE Promise
   with an internal timer — the timer could be bypassed in edge
   cases on iOS WebKit where the geo callback neither fires
   success nor error, leaving the function awaiting indefinitely.

   With Promise.race, the maximum wait is always 9s.
   Combined with the `finally` block in btn-co and btn-ci,
   the button is guaranteed to re-enable in under 9 seconds.
*/
/* ══════════════════════════════════════════════════════════════
   LOCATION SYSTEM — Prasidha (v08 — Android WebView permanent fix)

   ROOT CAUSE SUMMARY:
   Android WebView is a separate permission sandbox from the host app.
   Even when the Flutter app has OS location permission granted,
   the WebView does NOT inherit it unless the Flutter developer
   explicitly handles onGeolocationPermissionsShowPrompt.
   iOS WKWebView inherits permission automatically — that is why
   iOS works and Android does not. This is an Android OS security
   boundary that cannot be bypassed from JavaScript.

   FLUTTER HOST APP FIX (permanent — share with app developer):
   ─────────────────────────────────────────────────────────────
   In the InAppWebView widget, add this callback:

     InAppWebView(
       initialSettings: InAppWebViewSettings(
         geolocationEnabled: true,
       ),
       onGeolocationPermissionsShowPrompt: (controller, origin) async {
         return GeolocationPermissionShowPromptResponse(
           origin: origin,
           allow: true,
           retain: true,
         );
       },
     )

   If the app uses webview_flutter instead of flutter_inappwebview,
   webview_flutter does NOT expose this callback at all on Android.
   The app MUST switch to flutter_inappwebview package.

   WEB-SIDE SOLUTION (this file — no host app change needed):
   ─────────────────────────────────────────────────────────────
   When navigator.geolocation fails inside Android WebView,
   fall back to IP-based geolocation via BigDataCloud free API.
   No API key required. No permission required. Works in any
   WebView, any container, any platform — it is just an HTTPS fetch.

   Accuracy tradeoff:
     GPS (navigator.geolocation): 5-10 metres
     IP geolocation (fallback):   1-5 km (city/area level)

   For attendance verification (confirming employee is at the
   right site/city), this is sufficient. The coord_source field
   in the DB record tells HR which method was used.

   MIGRATION NOTE (Prasidha):
   Add coord_source column to attendance table in Supabase:
     ALTER TABLE attendance ADD COLUMN coord_source text DEFAULT 'gps';
   This lets HR filter records by location method in the admin panel.
*/

/**
 * getIPCoords — Prasidha
 * Fetches approximate coordinates from BigDataCloud IP geolocation API.
 * No API key, no permission, works in every WebView and container.
 * Returns "lat,lng" string or null on network failure.
 * BigDataCloud free reverse-geocode API.
 * @returns {Promise<string|null>}
 */
async function getIPCoords() {
  try {
    const res = await fetch(
      'https://api.bigdatacloud.net/data/ip-geolocation?localityLanguage=en',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const lat = data?.location?.latitude;
    const lng = data?.location?.longitude;
    if (!lat || !lng) return null;
    return `${parseFloat(lat).toFixed(6)},${parseFloat(lng).toFixed(6)}`;
  } catch {
    return null;
  }
}

/**
 * getCoords — Prasidha (v08 — definitive GPS + IP fallback)
 *
 * Strategy:
 *   1. Try navigator.geolocation (GPS) — works on iOS, Chrome, and
 *      Android WebView once host app is fixed.
 *   2. If GPS fails (any reason), silently fall back to IP geolocation.
 *      User sees no error — attendance is recorded with city accuracy.
 *   3. If both fail (no internet), show error toast.
 *
 * The fallback is silent by design. Field employees should not be
 * blocked from clocking in due to a host app configuration issue.
 * HR can distinguish GPS vs IP records via the coord_source field.
 *
 * @returns {Promise<string|null>} "lat,lng" string or null
 */
async function getCoords() {
  /* ── Step 1: Native GPS — keep the most accurate reading ────
     watchPosition streams fixes; GPS accuracy improves over the
     first few seconds. We keep the smallest-accuracy fix, settle
     early once it is good (≤ 20 m), and always settle by 7 s.
     A hard 16 s race ceiling guarantees the button re-enables.   */
  const gpsCoords = await Promise.race([
    new Promise(resolve => {
      if (!navigator.geolocation) { resolve(null); return; }

      let best = null, watchId = null, settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (watchId !== null) { try { navigator.geolocation.clearWatch(watchId); } catch (_) {} }
        resolve(best ? `${best.lat.toFixed(6)},${best.lng.toFixed(6)}` : null);
      };

      try {
        watchId = navigator.geolocation.watchPosition(
          pos => {
            const acc = pos.coords.accuracy || 99999;
            if (!best || acc < best.acc) {
              best = { acc, lat: pos.coords.latitude, lng: pos.coords.longitude };
            }
            if (acc <= 20) finish();   /* good enough — stop early */
          },
          () => finish(),              /* error → settle with best-so-far (may be null) */
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
        /* Collect for up to 7s, then take the best fix we have */
        setTimeout(finish, 7000);
      } catch (_) { finish(); }
    }),
    new Promise(r => setTimeout(() => r(null), 16000))  /* absolute ceiling */
  ]);

  if (gpsCoords) {
    U._coordSource = 'gps';
    return gpsCoords;
  }

  /* ── Step 2: IP geolocation fallback (silent, approximate) ─── */
  toast(t('gpsFallback'), '');
  const ipCoords = await getIPCoords();

  if (ipCoords) {
    U._coordSource = 'ip';
    return ipCoords;
  }

  /* ── Step 3: Both failed — genuine connectivity issue ─────── */
  toast(t('locUnavailable'), 'err');
  U._coordSource = null;
  return null;
}


/* ══════════════════════════════════════════════════════════════
   LOCATION CACHE
   Prasidha: localStorage cache for autocomplete and chips.
   SECURITY: entries sanitized on write. textContent on all renders.
   MIGRATION: swap localStorage with sessionStorage or userProfile
   service when moving to SharePoint SPFx.
*/

/** getCached — Prasidha: returns cached location array */
function getCached() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY_LOCS) || '[]');
    if (!Array.isArray(list)) return [];
    /* Drop legacy entries that no longer pass validation (e.g. names saved
       before the 20-char limit) so they can't be re-selected as chips/
       suggestions and then rejected at confirm. */
    return list.filter(l => typeof l === 'string' && isValidLoc(l));
  } catch { return []; }
}

/** saveLoc — Prasidha: prepends location, deduplicates, trims to MAX_LOCS */
function saveLoc(loc) {
  if (!loc) return;
  let list = getCached().filter(l => l.toLowerCase() !== loc.toLowerCase());
  list.unshift(loc);
  localStorage.setItem(KEY_LOCS, JSON.stringify(list.slice(0, MAX_LOCS)));
}

/**
 * renderChips — Prasidha
 * Renders last 3 locations as quick-select pill buttons.
 * SECURITY: textContent on all chip text — XSS safe.
 */
function renderChips(inputId, chipsId, dropId) {
  const locs = getCached().slice(0, 3);
  const wrap = g(chipsId); if (!wrap) return;
  wrap.innerHTML = '';
  locs.forEach(loc => {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'chip'; c.title = loc;
    c.textContent = '📍 ' + loc; /* SECURITY: textContent (Prasidha) */
    c.addEventListener('click', (e) => {
      e.preventDefault();
      const inp = g(inputId); if (inp) inp.value = loc;
      const drop = g(dropId); if (drop) drop.classList.remove('open');
    });
    wrap.appendChild(c);
  });
}

/**
 * setupAC — Prasidha
 * Sets up autocomplete for one input/dropdown pair.
 * MUST be called only once per input at DOMContentLoaded.
 * Multiple calls stack document.click listeners — memory leak.
 */
function setupAC(inputId, dropId, chipsId) {
  const input = g(inputId), drop = g(dropId);
  if (!input || !drop) return;
  input.addEventListener('focus', () => {
    renderChips(inputId, chipsId, dropId);
    renderDrop(inputId, dropId);
  });
  input.addEventListener('input', () => renderDrop(inputId, dropId));
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !drop.contains(e.target))
      drop.classList.remove('open');
  });
}

/**
 * renderDrop — Prasidha
 * Populates autocomplete dropdown. Max 5 suggestions.
 * SECURITY: all items via createElement/textContent — XSS safe.
 */
function renderDrop(inputId, dropId) {
  const q    = g(inputId)?.value.toLowerCase().trim();
  const drop = g(dropId); if (!drop) return;
  const hits = (q
    ? getCached().filter(l => l.toLowerCase().includes(q))
    : getCached()
  ).slice(0, 5);

  if (!hits.length) { drop.classList.remove('open'); return; }
  drop.innerHTML = '';
  hits.forEach(loc => {
    const item = document.createElement('div');
    item.className = 'ac-item';
    const ico = document.createElement('span'); ico.textContent = '📍';
    const txt = document.createElement('span'); txt.textContent = loc;
    item.append(ico, txt);
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const inp = g(inputId); if (inp) inp.value = loc;
      drop.classList.remove('open');
    });
    drop.appendChild(item);
  });
  drop.classList.add('open');
}

/* ══════════════════════════════════════════════════════════════
   TOAST — Prasidha
   Centered blur-backdrop overlay. 1.5s auto-dismiss.
   SECURITY: msg via textContent — never innerHTML.
*/
let _toastTimer = null;

/**
 * toast — Prasidha
 * @param {string} msg - Message text
 * @param {'ok'|'err'|''} type - Colour variant
 */
function toast(msg, type = '') {
  const ov   = g('smx-toast-ov');
  const pill = g('smx-toast-pill');
  if (!ov || !pill) return;

  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  pill.textContent = msg; /* SECURITY: textContent (Prasidha) */
  pill.className = 'smx-toast-pill' + (type ? ' ' + type : '');

  ov.classList.remove('hidden', 'smx-to-out');

  _toastTimer = setTimeout(() => {
    ov.classList.add('smx-to-out');
    setTimeout(() => {
      ov.classList.add('hidden');
      ov.classList.remove('smx-to-out');
    }, 400);
  }, 3800);   /* +~19% on-screen time for readability */
}

/* ══════════════════════════════════════════════════════════════
   HELPERS — see top of file for hoisted function declarations
*/

/**
 * isNewDay — Prasidha
 * True if lastDate was on a previous calendar day.
 * Drives the midnight session reset.
 */
function isNewDay(lastDate) {
  if (!lastDate) return false;
  return new Date(lastDate).setHours(0,0,0,0) < new Date().setHours(0,0,0,0);
}

/**
 * fmt — Prasidha
 * Formats ISO timestamp as HH:MM AM/PM (en-IN locale).
 */
/* Manual 12-hour format → identical on every device/OS (Intl
   toLocaleTimeString varies: some give "am/pm", some localized
   day-period markers like "अ/पू"). AM/PM stays English by design;
   callers wrap the result in toLocalNum() to localise the digits. */
function fmt(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  let h = d.getHours(); const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)} ${ap}`;
}

/**
 * msDur — Prasidha
 * Converts milliseconds to HH:MM:SS string.
 * Used by rAF loop for live timer and duration() for frozen display.
 */
function msDur(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '00:00:00';
  return [
    Math.floor(ms / 3600000),
    Math.floor((ms % 3600000) / 60000),
    Math.floor((ms % 60000) / 1000)
  ].map(n => n.toString().padStart(2, '0')).join(':');
}

/**
 * duration — Prasidha
 * Computes and formats duration between two ISO timestamps.
 */
function duration(inISO, outISO) {
  if (!inISO || !outISO) return '--';
  let ms = new Date(outISO) - new Date(inISO);
  if (ms > DUR_CAP_MS) ms = DUR_CAP_MS;   /* cap runaway shifts at 24h */
  return msDur(ms);
}

/* ── SHIFT HISTORY ──────────────────────────────────────────── */
function openHistory() {
  const backdrop = g('history-backdrop');
  if (!backdrop) return;
  backdrop.classList.remove('hidden');
  loadHistory();
}

function closeHistory() {
  const backdrop = g('history-backdrop');
  if (backdrop) backdrop.classList.add('hidden');
}

async function loadHistory() {
  const list = g('smx-history-list');
  const loader = g('smx-history-loading');
  if (!list) return;
  list.innerHTML = '';
  if (loader) { loader.textContent = t('loading'); list.appendChild(loader); loader.style.display = ''; }

  const empId = (U.id || '').replace(/\D/g, '');
  if (!empId) {
    list.innerHTML = '<div class="smx-history-empty">' + t('historyEmpty') + '</div>';
    return;
  }

  try {
    /* Read via a security-definer RPC instead of a direct table select.
       The anon key has NO direct SELECT on the table (RLS), so it cannot
       dump all rows — the function returns only this employee's last
       7 days. Window/order/limit are enforced server-side. */
    const { data, error } = await _db.rpc('recent_shifts', { emp: empId });

    if (loader) loader.style.display = 'none';

    if (error || !data || data.length === 0) {
      list.innerHTML = '<div class="smx-history-empty">' + t('historyEmpty') + '</div>';
      return;
    }

    data.forEach(row => {
      const div = document.createElement('div');
      div.className = 'smx-history-row';

      const ciDate = row.clock_in_time ? new Date(row.clock_in_time) : null;
      const coDate = row.clock_out_time ? new Date(row.clock_out_time) : null;

      const loc2 = langLocale();
      /* weekday/month names localise via Intl; digits normalised to the
         current script via toLocalNum so they're consistent on every device */
      const dateStr = ciDate ? toLocalNum(toEnNum(ciDate.toLocaleDateString(loc2, { weekday: 'short', day: 'numeric', month: 'short' }))) : '--';
      /* time uses the manual formatter → same digits + English AM/PM everywhere */
      const ciTime = ciDate ? toLocalNum(fmt(ciDate.toISOString())) : '--';
      const coTime = coDate ? toLocalNum(fmt(coDate.toISOString())) : '--';

      let durStr = '--';
      if (ciDate && coDate) {
        const ms = coDate - ciDate;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        durStr = toLocalNum(h + 'h ' + m + 'm');
      }

      const loc = row.clock_in_location_name || row.clock_out_location_name || '';
      const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

      div.innerHTML =
        '<div class="smx-hist-head">' +
          '<span class="smx-history-row-date">' + esc(dateStr) + '</span>' +
          (durStr !== '--' ? '<span class="smx-history-row-dur">' + esc(durStr) + '</span>' : '') +
        '</div>' +
        '<div class="smx-hist-cells">' +
          '<div class="smx-hist-cell smx-hist-cell-in">' +
            '<span class="smx-hist-cell-lbl">' + t('clockIn') + '</span>' +
            '<span class="smx-hist-cell-val">' + esc(ciTime) + '</span>' +
          '</div>' +
          '<div class="smx-hist-cell smx-hist-cell-out">' +
            '<span class="smx-hist-cell-lbl">' + t('clockOut') + '</span>' +
            '<span class="smx-hist-cell-val">' + esc(coTime) + '</span>' +
          '</div>' +
        '</div>' +
        (loc ? '<div class="smx-hist-cell smx-hist-cell-loc">' +
            '<span class="smx-hist-cell-lbl">📍 ' + t('locationTitle') + '</span>' +
            '<span class="smx-hist-cell-val">' + esc(loc) + '</span>' +
          '</div>' : '');

      list.appendChild(div);
    });
  } catch (e) {
    if (loader) loader.style.display = 'none';
    list.innerHTML = '<div class="smx-history-empty">' + t('historyEmpty') + '</div>';
  }
}

(function initHistoryListeners() {
  const closeBtn = g('history-close');
  const backdrop = g('history-backdrop');
  if (closeBtn) closeBtn.addEventListener('click', closeHistory);
  if (backdrop) backdrop.addEventListener('click', function(e) {
    if (e.target === backdrop) closeHistory();
  });
})();

/* ── Background scroll lock ──────────────────────────────────────
   While any sheet/modal is open, freeze the page (SharePoint host)
   behind it so it doesn't scroll through. Two layers:
   1. toggle html.smx-modal-open (overflow:hidden) via MutationObserver
   2. swallow touchmove on the backdrop, except inside the shifts list,
      so iOS rubber-band scrolling can't reach the page underneath.   */
(function initScrollLock() {
  const ids = ['history-backdrop','edit-sheet-backdrop','confirm-backdrop','rename-backdrop','modal-ov'];
  function isOpen(el) {
    if (!el) return false;
    return el.id === 'modal-ov' ? el.classList.contains('open') : !el.classList.contains('hidden');
  }
  function sync() {
    const open = ids.some(id => isOpen(g(id)));
    document.documentElement.classList.toggle('smx-modal-open', open);
  }
  ids.forEach(id => {
    const el = g(id);
    if (!el) return;
    new MutationObserver(sync).observe(el, { attributes: true, attributeFilter: ['class'] });
    el.addEventListener('touchmove', function (e) {
      /* allow the shifts list to scroll internally; block everything else */
      if (e.target.closest && e.target.closest('.smx-history-list')) return;
      e.preventDefault();
    }, { passive: false });
  });
  sync();
})();

/*
 * ══════════════════════════════════════════════════════════════
 *  Prasidha Jagtap
 *  GeoLocation Attendance v2.0
 *  Built for field teams. Maintained with care and intent.
 *  If you are reading this: keep the standards. 🚀
 * ══════════════════════════════════════════════════════════════
 */

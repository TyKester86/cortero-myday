/**
 * Public Privacy Policy and Terms (readable signed out, linked from the
 * landing page and Settings). Plain language; describes what the app
 * actually does. Have a lawyer review before charging customers.
 */
const CONTACT = 'privacy@conquermyday.app';
const UPDATED = 'October 3, 2026';

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal">
      <header className="lp-top">
        <a className="lp-brand" href="/">
          <img src="/icons/myday-mark.svg" alt="" width={28} height={28} />
          MyDay
        </a>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="muted small">Last updated {UPDATED}</p>
        {children}
        <p className="small muted">
          Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
        </p>
      </main>
    </div>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy Policy">
      <p>
        MyDay helps a household run its day. This explains what we collect, why, who helps us run the service, and the choices you have. The short version: your
        household’s information is used to run MyDay for your household. We don’t sell it, and we don’t use it for advertising.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Account:</b> your name and email from Google sign-in.</li>
        <li><b>Your household:</b> the names (and, if you add them, ages) of the people in it, and how they sign in (kids can use a name and PIN).</li>
        <li><b>What you put in:</b> chores, homework, tasks, notes, check-ins, plans, meals, grocery lists, bills and goals.</li>
        <li><b>Health (optional):</b> your build, workouts, body measurements you choose to enter, opt-in weigh-ins and opt-in progress photos.</li>
        <li><b>Money (optional):</b> if you link a bank through Plaid, account names, balances and transactions. Access is read-only — MyDay cannot move money.</li>
        <li><b>School (optional):</b> classes, assignments, lecture recordings and the notes made from them, and Google Classroom data if you connect it.</li>
        <li><b>Usage:</b> which features are used and basic technical logs, so we can keep the service working and improve it.</li>
      </ul>
      <h2>How we use it</h2>
      <p>To provide MyDay to your household: show your day, plan meals and workouts, send the reminders you turn on, and answer what you ask the assistant. We don’t sell personal information or share it for advertising.</p>
      <h2>Who helps us run MyDay</h2>
      <ul>
        <li><b>Hosting:</b> our servers and database (DigitalOcean, United States).</li>
        <li><b>AI:</b> when you ask Hana, the tutor, or turn a lecture into notes, the relevant text is sent to Anthropic to produce the answer. Lecture audio is sent to OpenAI for transcription. These providers process it to answer the request.</li>
        <li><b>Banking:</b> Plaid, only if you link a bank.</li>
        <li><b>Sign-in:</b> Google.</li>
        <li><b>Payments:</b> our payment processor, once you subscribe. We never see or store full card numbers.</li>
      </ul>
      <h2>Children</h2>
      <p>
        A parent or guardian creates every child’s profile and controls it. For children under 13, the AI tutor, lecture notes and other features that send a child’s
        words to an AI provider stay off until a parent gives consent in the app. Parents can review, export or delete their child’s information at any time, and can
        withdraw consent. Kids’ private notes are visible only to the child.
      </p>
      <h2>Lecture recordings</h2>
      <p>Audio is kept only until it has been turned into notes, then deleted. Recording a class requires the student to confirm their school’s policy and permission first.</p>
      <h2>Security</h2>
      <p>Each household’s data is walled off from every other household in the database. Bank tokens and progress photos are encrypted. Connections use HTTPS.</p>
      <h2>Your choices</h2>
      <ul>
        <li><b>Export:</b> download your household’s data any time (Settings → Your data).</li>
        <li><b>Delete:</b> delete your account or your whole household any time (Settings → Your data). Deletion is permanent.</li>
        <li><b>Turn things off:</b> weigh-ins, progress photos, reminders, bank links and Classroom are all optional and can be turned off.</li>
      </ul>
      <p>Depending on where you live (for example California), you may have additional rights to know, correct or delete your information. Contact us to use them.</p>
      <h2>Changes</h2>
      <p>If we make a meaningful change, we’ll tell you in the app before it takes effect.</p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms of Service">
      <p>By creating a household or signing in to MyDay, you agree to these terms.</p>
      <h2>Your household</h2>
      <p>The grown-up who creates a household is responsible for it and for the people they invite or add. You must be 18 or older to create a household. Children use MyDay under a parent or guardian’s supervision.</p>
      <h2>Trial and subscription</h2>
      <p>Every household starts with a free 30-day trial. After that, MyDay is a paid subscription for the household. You’ll see the price before you’re asked to pay, and you can cancel any time; your access continues to the end of the paid period.</p>
      <h2>Health and fitness</h2>
      <p>
        MyDay’s workout and nutrition plans are general information based on published research, not medical advice. Talk to a clinician before starting a new program —
        especially if you are pregnant, recently gave birth, have a health condition, or have a history of disordered eating. Stop and seek care if something hurts or feels wrong.
      </p>
      <h2>Money</h2>
      <p>MyDay shows information from your bank to help you plan. It is not financial advice and cannot move money.</p>
      <h2>AI features</h2>
      <p>Hana, the tutor and lecture notes are produced by AI and can be wrong. Check anything important.</p>
      <h2>Acceptable use</h2>
      <p>Don’t use MyDay to harass anyone, to record people without the permission your school or state requires, or to break the law. We may suspend accounts that do.</p>
      <h2>Your content</h2>
      <p>What you put into MyDay is yours. You give us permission to store and process it only to run MyDay for you.</p>
      <h2>Availability and liability</h2>
      <p>We work hard to keep MyDay running and your data safe, but the service is provided “as is”. To the extent the law allows, our liability is limited to what you paid in the last 12 months.</p>
      <h2>Changes</h2>
      <p>We’ll tell you in the app before meaningful changes to these terms take effect.</p>
    </Page>
  );
}

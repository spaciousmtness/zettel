// Getting a secret to a person. Two providers, both swappable, neither one
// load-bearing on the auth logic — auth.js does not know or care how a code
// travelled, which is what keeps this file replaceable.
//
// IMPORTANT: in development, an unconfigured sender logs the code to the
// Worker console so the flow can be walked end to end. In production it
// throws instead, because a sign-in that silently succeeds while nothing
// was ever delivered is indistinguishable to the caller from one that
// worked — and the caller in that case is someone locked out of an account.

const FROM_NAME = "Zettel";

export async function sendEmail(env, to, link) {
  if (!env.RESEND_API_KEY) {
    // Opt IN, never opt out. Gating on `ENVIRONMENT !== "production"` meant a
    // deploy that forgot --env production silently chose the logging branch
    // and wrote live sign-in secrets into the Worker log, where anyone with a
    // tail session could complete the sign-in.
    if (!env.ALLOW_CONSOLE_SECRETS) {
      throw new Error("no email sender configured");
    }
    console.log(`[dev] magic link for ${to}: ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${env.MAIL_FROM}>`,
      to: [to],
      subject: "Your way in to Zettel",
      // Plain text on purpose. An HTML mail from an unknown sender with a
      // single big button is the exact shape of a phishing mail, and we are
      // asking people to trust a link that signs them in.
      text: [
        "Here's your link. It works once, and only for the next 15 minutes.",
        "",
        link,
        "",
        "If you didn't ask for this, nothing has happened to your account —",
        "you can ignore this and the link expires on its own.",
      ].join("\n"),
    }),
  });
  if (!res.ok) throw new Error(`email send failed: ${res.status}`);
}

export async function sendSms(env, to, code) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    if (!env.ALLOW_CONSOLE_SECRETS) {
      throw new Error("no sms sender configured");
    }
    console.log(`[dev] code for ${to}: ${code}`);
    return;
  }
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " +
          btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: env.TWILIO_FROM,
        // The leading "Zettel:" matters — iOS autofill reads a code out of
        // an SMS more reliably when the message names the service, and a
        // code with no context is the thing people forward to scammers.
        Body: `Zettel: ${code} is your code. It expires in 10 minutes. ` +
              `We will never ask you for it.`,
      }),
    });
  if (!res.ok) throw new Error(`sms send failed: ${res.status}`);
}

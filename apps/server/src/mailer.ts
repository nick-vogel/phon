/**
 * How the Worker sends email. The Worker builder takes a mailer beside `authenticate`: the deployed
 * entry sends through the `send_email` binding, and a test passes a recording mailer.
 */
export type Mailer = (message: EmailMessageBuilder, env: Env) => Promise<void>

/** The deployed mailer: Cloudflare Email Sending through the `EMAIL` binding, and nothing else. */
export const bindingMailer: Mailer = async (message, env) => {
  await env.EMAIL.send(message)
}

/** The sender of every sign-in code. */
export const SIGN_IN_SENDER = { email: 'sign-in@phon.chat', name: 'Phon' } as const

/** How long a sign-in code works, in minutes, as the email says it. */
export const CODE_MINUTES = 10

/**
 * The email that carries a sign-in code: the code first in the body, never in the subject, then
 * how long it works and that a person who did not ask can ignore it. A text part and an HTML part
 * say the same.
 */
export function signInCodeEmail(to: string, code: string): EmailMessageBuilder {
  const lasts = `This is your Phon sign-in code. It works for ${CODE_MINUTES} minutes.`
  const ignore = 'If you did not ask for a code, you can ignore this email.'
  return {
    to,
    from: { ...SIGN_IN_SENDER },
    subject: 'Your Phon sign-in code',
    text: `${code}\n\n${lasts}\n\n${ignore}\n`,
    html: [
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>`,
      `<p>${lasts}</p>`,
      `<p>${ignore}</p>`,
    ].join('\n'),
  }
}

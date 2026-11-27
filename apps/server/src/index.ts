import { bindingMailer } from './mailer.ts'
import { sessions } from './session.ts'
import { createWorker } from './worker.ts'

export { Channel } from './channel.ts'
export { ChurchDirectory } from './church-directory.ts'
export { ChurchRegistry } from './church-registry.ts'

/**
 * The deployed Worker. A request is authenticated by its Phon session, an email goes out through
 * the `send_email` binding, and its Cron Trigger runs the roster sync.
 */
export default createWorker({ authenticate: sessions, mailer: bindingMailer })

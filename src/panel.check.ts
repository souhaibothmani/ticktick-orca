// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh host.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  // No token stored: the Connect screen.
  fresh: {}
})

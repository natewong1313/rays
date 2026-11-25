//// Runtime checks for native rejection and background-task ownership.

import gleam/javascript/promise.{type Promise}

@external(javascript, "./promise_test_ffi.mts", "earlyBackgroundFailure")
pub fn background_failure_before_response_is_observed_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "nestedBackgroundWork")
pub fn nested_background_work_is_drained_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "backgroundFailureDrainsAll")
pub fn background_failure_waits_for_other_tasks_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "handlerFailureDrainsAll")
pub fn handler_failure_drains_background_work_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "simulatedBackgroundFailure")
pub fn simulated_context_observes_early_rejection_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "unprintableBodyErrors")
pub fn unprintable_body_errors_remain_typed_test() -> Promise(Nil)

@external(javascript, "./promise_test_ffi.mts", "synchronousBodyFailure")
pub fn synchronous_body_failure_remains_typed_test() -> Promise(Nil)

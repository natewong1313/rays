//// Tests for `rays/durable_object` that run without the Workers runtime.
//// Classes, instances and calls are tested with a real build in
//// `packages/core`, and in the runtime in `packages/integration-tests`.

import rays/durable_object
import rays/worker_rpc

pub fn failure_to_call_error_test() {
  assert durable_object.failure_to_call_error(#("reset", "post", "crashed"))
    == durable_object.Reset(method: "post", message: "crashed")
  assert durable_object.failure_to_call_error(#("overloaded", "post", "busy"))
    == durable_object.Overloaded(method: "post")
  assert durable_object.failure_to_call_error(#("retryable", "post", "moved"))
    == durable_object.Retryable(method: "post", message: "moved")
  assert durable_object.failure_to_call_error(#("send", "post", "gone"))
    == durable_object.RpcFailed(worker_rpc.SendFailed(
      method: "post",
      message: "gone",
    ))
  assert durable_object.failure_to_call_error(#("not_bound", "post", ""))
    == durable_object.RpcFailed(worker_rpc.NotBound(method: "post"))
}

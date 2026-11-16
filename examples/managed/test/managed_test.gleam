import gleam/http
import gleam/javascript/promise
import gleeunit
import managed
import rays/workers/simulate

pub fn main() -> Nil {
  gleeunit.main()
}

pub fn hello_test() {
  let env = simulate.env() |> simulate.env_var("GREETING", "Hi")
  let request = simulate.request(http.Get, "/Joe")
  use response <- promise.map(managed.handle_request(
    request,
    env,
    simulate.context(),
  ))
  assert response.status == 200
  assert simulate.read_body(response) == "Hi, Joe!"
}

//! Calls to the Daynote API on Vercel.

use reqwest::Method;
use serde_json::Value;

const DEFAULT_API: &str = "https://personalnote-mu.vercel.app";

pub enum CloudError {
    /// The API could not be reached at all.
    Offline,
    Status(u16, String),
}

/// `DAYNOTE_API` points a development build at another deployment.
fn base() -> String { std::env::var("DAYNOTE_API").unwrap_or_else(|_| DEFAULT_API.to_owned()) }

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().expect("HTTP client")
}

pub async fn call(http: &reqwest::Client, method: Method, path: &str, token: Option<&str>, body: Option<&Value>) -> Result<Value, CloudError> {
    let mut request = http.request(method, format!("{}{path}", base()));
    if let Some(token) = token { request = request.bearer_auth(token) }
    if let Some(body) = body { request = request.json(body) }
    let response = request.send().await.map_err(|_| CloudError::Offline)?;
    let status = response.status().as_u16();
    let data: Value = response.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) { return Ok(data) }
    let message = data["error"].as_str().unwrap_or("Something went wrong. Please try again.").to_owned();
    Err(CloudError::Status(status, message))
}

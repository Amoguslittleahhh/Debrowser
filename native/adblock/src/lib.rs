//! Network ad and tracker matching for blocker.js, on Brave's adblock-rust.
//! Only the per-request yes/no lives here; cosmetic filters stay in Ghostery.
use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine as Inner;
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub struct Engine(Inner);

#[napi]
impl Engine {
  /// Builds from filter-list text (several lists joined by newlines).
  #[napi(factory)]
  pub fn parse(rules: String) -> Engine {
    let mut set = FilterSet::new(false);
    set.add_filter_list(rules, ParseOptions::default());
    Engine(Inner::new_with_filter_set(set))
  }

  /// From bytes written by serialize(); throws on a corrupt or old file.
  #[napi(factory)]
  pub fn deserialize(bytes: Buffer) -> Result<Engine> {
    let mut e = Inner::default();
    e.deserialize(&bytes).map_err(|err| Error::from_reason(format!("{err:?}")))?;
    Ok(Engine(e))
  }

  #[napi]
  pub fn serialize(&self) -> Buffer {
    self.0.serialize().into()
  }

  /// `kind` is a request type as Chromium/Electron names it ("script", "image"...).
  /// No redirect resources are loaded, so a $redirect rule simply blocks.
  #[napi]
  pub fn check(&self, url: String, source: String, kind: String, method: String) -> bool {
    Request::new(&url, &source, kind_of(&kind), &method)
      .map(|req| self.0.check_network_request(&req).should_block())
      .unwrap_or(false)
  }

  /// The $csp policies for a page or frame, joined by ";", or null.
  #[napi]
  pub fn csp(&self, url: String, source: String, kind: String) -> Option<String> {
    Request::new(&url, &source, kind_of(&kind), "GET").ok().and_then(|req| self.0.get_csp_directives(&req))
  }
}

/// Electron's resourceType to adblock-rust's request type names.
fn kind_of(t: &str) -> &'static str {
  match t {
    "mainFrame" => "document",
    "subFrame" => "subdocument",
    "stylesheet" => "stylesheet",
    "script" => "script",
    "image" => "image",
    "font" => "font",
    "object" => "object",
    "xhr" => "xmlhttprequest",
    "ping" => "ping",
    "cspReport" => "csp_report",
    "media" => "media",
    "webSocket" => "websocket",
    _ => "other",
  }
}

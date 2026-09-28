// Streaming view, macOS: Apple's WebKit (WKWebView) inside a Debrowser window,
// for the sites whose DRM needs FairPlay - which macOS provides to any app
// embedding WebKit, and Chromium does not have.
//
// A subview of the Electron window's content view, sized over the page area
// by JavaScript. Everything here runs on the main thread, where Electron's
// main process runs JavaScript; events go back through events.h.

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

#include <map>
#include <string>

#include "events.h"

@interface SVDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic) int viewId;
@end

@implementation SVDelegate
- (void)webView:(WKWebView*)webView didFinishNavigation:(WKNavigation*)navigation {
  sv_emit(self.viewId, "navigated", webView.URL.absoluteString.UTF8String ?: "", "ok");
  sv_emit(self.viewId, "title", webView.title.UTF8String ?: "");
}
- (void)webView:(WKWebView*)webView didFailNavigation:(WKNavigation*)navigation withError:(NSError*)error {
  sv_emit(self.viewId, "navigated", webView.URL.absoluteString.UTF8String ?: "", "failed");
}
- (void)webView:(WKWebView*)webView
    didFailProvisionalNavigation:(WKNavigation*)navigation
                       withError:(NSError*)error {
  sv_emit(self.viewId, "navigated", webView.URL.absoluteString.UTF8String ?: "", "failed");
}
@end

namespace {

struct View {
  NSView* parent = nil;
  WKWebView* web = nil;
  SVDelegate* delegate = nil;
};

std::map<int, View> g_views;
int g_next_id = 1;

NSString* Str(const std::string& s) { return [NSString stringWithUTF8String:s.c_str()]; }

// The content view is not flipped: y counts up from the bottom. Bounds come
// from JavaScript counting down from the top, as everywhere else in Electron.
NSRect Frame(NSView* parent, double x, double y, double w, double h) {
  if (parent.isFlipped) return NSMakeRect(x, y, w, h);
  return NSMakeRect(x, parent.bounds.size.height - y - h, w, h);
}

std::string Json(id value) {
  if (!value || value == [NSNull null]) return "null";
  if ([NSJSONSerialization isValidJSONObject:@[ value ]]) {
    NSData* data = [NSJSONSerialization dataWithJSONObject:@[ value ] options:0 error:nil];
    NSString* s = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    // Strip the array wrapper that let a bare string or number serialise.
    if (s.length >= 2) return std::string([s substringWithRange:NSMakeRange(1, s.length - 2)].UTF8String);
  }
  return std::string([value description].UTF8String ?: "null");
}

}  // namespace

// create(nativeViewHandle: Buffer, { url, userAgent, x, y, width, height }) -> id
static napi_value sv_create(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSView* parent = (__bridge NSView*)sv_buffer_pointer(env, argv[0]);
  if (!parent || ![parent isKindOfClass:[NSView class]]) {
    napi_throw_error(env, nullptr, "streamview: not a view handle");
    return nullptr;
  }

  WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
  config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
  if (@available(macOS 12.3, *)) config.preferences.elementFullscreenEnabled = YES;

  const NSRect frame = Frame(parent, sv_prop_number(env, argv[1], "x"), sv_prop_number(env, argv[1], "y"),
                             sv_prop_number(env, argv[1], "width"), sv_prop_number(env, argv[1], "height"));
  WKWebView* web = [[WKWebView alloc] initWithFrame:frame configuration:config];
  const std::string ua = sv_prop_string(env, argv[1], "userAgent");
  if (!ua.empty()) web.customUserAgent = Str(ua);

  // Not `id`: that is Objective-C's object type, and a variable of the name
  // shadows it inside every block below.
  const int viewId = g_next_id++;
  SVDelegate* delegate = [[SVDelegate alloc] init];
  delegate.viewId = viewId;
  web.navigationDelegate = delegate;
  [parent addSubview:web positioned:NSWindowAbove relativeTo:nil];
  g_views[viewId] = View{parent, web, delegate};

  const std::string url = sv_prop_string(env, argv[1], "url");
  if (!url.empty()) [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:Str(url)]]];

  // WebKit is ready as soon as it exists; the event keeps the two platforms alike.
  NSOperatingSystemVersion os = [[NSProcessInfo processInfo] operatingSystemVersion];
  sv_emit(viewId, "runtime", std::to_string(os.majorVersion) + "." + std::to_string(os.minorVersion));
  sv_emit(viewId, "ready", web.customUserAgent.UTF8String ?: "");

  napi_value out;
  napi_create_int32(env, viewId, &out);
  return out;
}

static napi_value sv_navigate(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto it = g_views.find(sv_int(env, argv[0]));
  if (it == g_views.end()) return nullptr;
  NSURL* url = [NSURL URLWithString:Str(sv_string(env, argv[1]))];
  if (url) [it->second.web loadRequest:[NSURLRequest requestWithURL:url]];
  return nullptr;
}

static napi_value sv_set_bounds(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto it = g_views.find(sv_int(env, argv[0]));
  if (it == g_views.end()) return nullptr;
  it->second.web.frame = Frame(it->second.parent, sv_int(env, argv[1]), sv_int(env, argv[2]),
                               sv_int(env, argv[3]), sv_int(env, argv[4]));
  return nullptr;
}

static napi_value sv_set_visible(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto it = g_views.find(sv_int(env, argv[0]));
  if (it == g_views.end()) return nullptr;
  it->second.web.hidden = !sv_bool(env, argv[1]);
  return nullptr;
}

// executeScript(id, token, script): result as a "script" event, value as JSON.
static napi_value sv_execute_script(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const int viewId = sv_int(env, argv[0]);
  const std::string token = sv_string(env, argv[1]);
  auto it = g_views.find(viewId);
  if (it == g_views.end()) {
    sv_emit(viewId, "script", token, "null");
    return nullptr;
  }
  [it->second.web evaluateJavaScript:Str(sv_string(env, argv[2]))
                   completionHandler:^(id result, NSError* error) {
                     sv_emit(viewId, "script", token, error ? "null" : Json(result));
                   }];
  return nullptr;
}

static napi_value sv_destroy(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto it = g_views.find(sv_int(env, argv[0]));
  if (it == g_views.end()) return nullptr;
  [it->second.web stopLoading];
  it->second.web.navigationDelegate = nil;
  [it->second.web removeFromSuperview];
  g_views.erase(it);
  return nullptr;
}

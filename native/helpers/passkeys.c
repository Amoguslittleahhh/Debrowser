/*
 * passkeys - which passkeys Windows holds for a site, so the browser can offer
 * them itself.
 *
 * Why this exists
 * ---------------
 * A sign-in with a passkey went straight to Windows' own "Choose a passkey"
 * dialog: a system window over the browser, listing every account. Chrome and
 * Edge show the accounts in their own UI instead - a list under the address
 * bar, or a dropdown under the sign-in field - and Windows Hello only asks
 * whether it is you. They read the list from webauthn.dll, which is what this
 * does, and then ask Windows for the one credential the user picked, which
 * skips Windows' picker.
 *
 * Only names and ids leave here: the list is what Windows shows anyone at this
 * desk in its own dialog, and the key never leaves Windows at all.
 *
 * Protocol
 * --------
 *   passkeys list <rpId>   ->  a JSON array on stdout, exit 0:
 *                              [{"id":"<base64url>","name":"...","display":"..."}]
 *                              [] when there are none
 *                          ->  exit 2: this Windows cannot list them (before
 *                              Windows 11 22H2, or webauthn.dll is missing)
 *                          ->  exit 3: the call failed; the HRESULT on stderr
 *
 * A spawn per sign-in, not a long-lived process: it is asked a few times a
 * day, and the browser keeps nothing running for it in between.
 */

#include <stdio.h>
#include <string.h>

#if defined(_WIN32)

#include <windows.h>

/* From webauthn.h. Declared here rather than included: the header is not in
   every SDK the release and developer machines build with, and only the fields
   up to the user's details are read - those are the same in every version. */
typedef struct {
  DWORD dwVersion;
  PCWSTR pwszId;
  PCWSTR pwszName;
  PCWSTR pwszIcon;
} RP_INFO;

typedef struct {
  DWORD dwVersion;
  DWORD cbId;
  PBYTE pbId;
  PCWSTR pwszName;
  PCWSTR pwszIcon;
  PCWSTR pwszDisplayName;
} USER_INFO;

typedef struct {
  DWORD dwVersion;
  DWORD cbCredentialID;
  PBYTE pbCredentialID;
  RP_INFO *pRpInformation;
  USER_INFO *pUserInformation;
} CRED_DETAILS;

typedef struct {
  DWORD cCredentialDetails;
  CRED_DETAILS **ppCredentialDetails;
} CRED_LIST;

typedef struct {
  DWORD dwVersion;
  PCWSTR pwszRpId;
  BOOL bBrowserInPrivateMode;
} GET_OPTIONS;

typedef DWORD (WINAPI *ApiVersionFn)(void);
typedef HRESULT (WINAPI *ListFn)(const GET_OPTIONS *, CRED_LIST **);
typedef void (WINAPI *FreeFn)(CRED_LIST *);

/* The list call arrived with API version 4 (Windows 11 22H2). */
#define LIST_API_VERSION 4
#define NTE_NOT_FOUND_HR ((HRESULT)0x80090011L)

static void put_b64url(const unsigned char *p, DWORD n) {
  static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (DWORD i = 0; i < n; i += 3) {
    unsigned v = (unsigned)p[i] << 16;
    if (i + 1 < n) v |= (unsigned)p[i + 1] << 8;
    if (i + 2 < n) v |= p[i + 2];
    putchar(A[(v >> 18) & 63]);
    putchar(A[(v >> 12) & 63]);
    if (i + 1 < n) putchar(A[(v >> 6) & 63]);
    if (i + 2 < n) putchar(A[v & 63]);
  }
}

/* A wide string as a JSON string, in UTF-8. */
static void put_json(PCWSTR w) {
  putchar('"');
  if (w) {
    char buf[1024];
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, buf, sizeof buf, NULL, NULL);
    for (int i = 0; i < len - 1; i++) {
      unsigned char c = (unsigned char)buf[i];
      if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
      else if (c < 0x20) printf("\\u%04x", c);
      else putchar(c);
    }
  }
  putchar('"');
}

static int list(const char *rp) {
  HMODULE dll = LoadLibraryW(L"webauthn.dll");
  if (!dll) return 2;
  ApiVersionFn version = (ApiVersionFn)(void *)GetProcAddress(dll, "WebAuthNGetApiVersionNumber");
  ListFn get = (ListFn)(void *)GetProcAddress(dll, "WebAuthNGetPlatformCredentialList");
  FreeFn release = (FreeFn)(void *)GetProcAddress(dll, "WebAuthNFreePlatformCredentialList");
  if (!version || !get || !release || version() < LIST_API_VERSION) return 2;

  WCHAR rpId[256];
  if (!MultiByteToWideChar(CP_UTF8, 0, rp, -1, rpId, 256)) return 3;
  GET_OPTIONS options = { 1, rpId, FALSE };
  CRED_LIST *found = NULL;
  HRESULT hr = get(&options, &found);
  if (hr == NTE_NOT_FOUND_HR) { puts("[]"); return 0; }
  if (FAILED(hr) || !found) { fprintf(stderr, "WebAuthNGetPlatformCredentialList: 0x%08lx\n", (unsigned long)hr); return 3; }

  putchar('[');
  int first = 1;
  for (DWORD i = 0; i < found->cCredentialDetails; i++) {
    CRED_DETAILS *c = found->ppCredentialDetails[i];
    if (!c || !c->pbCredentialID || !c->cbCredentialID) continue;
    /* Asked for one site, but checked: a name shown under the wrong site
       would be offered to it. */
    if (!c->pRpInformation || !c->pRpInformation->pwszId || wcscmp(c->pRpInformation->pwszId, rpId) != 0) continue;
    if (!first) putchar(',');
    first = 0;
    fputs("{\"id\":\"", stdout);
    put_b64url(c->pbCredentialID, c->cbCredentialID);
    fputs("\",\"name\":", stdout);
    put_json(c->pUserInformation ? c->pUserInformation->pwszName : NULL);
    fputs(",\"display\":", stdout);
    put_json(c->pUserInformation ? c->pUserInformation->pwszDisplayName : NULL);
    putchar('}');
  }
  puts("]");
  release(found);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "list") != 0 || strlen(argv[2]) > 253) {
    fprintf(stderr, "usage: passkeys list <rpId>\n");
    return 64;
  }
  return list(argv[2]);
}

#else

/* Only Windows keeps passkeys this way: macOS's are in iCloud Keychain behind
   an entitlement this app does not have, and Linux has no platform store. */
int main(void) {
  return 2;
}

#endif

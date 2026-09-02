/**
 * Re-export of the provider-neutral HTTP seam, kept so existing WaveSpeed
 * imports keep resolving while the seam itself lives one level up.
 *
 * It moved because fal needs the same contract, and two copies of "exactly one
 * outbound request" would eventually disagree — the copy nobody edited being
 * the one still used by the paid path.
 */
export {
  FetchHttpClient,
  type HttpClient,
  type HttpRedirectMode,
  type HttpRequest,
  type HttpResponse,
} from "../http";

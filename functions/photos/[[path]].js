// /photos/* -> the Supabase Edge Function (see ../_forward.js). The browser's cookie goes along: pictures need a login.
import { forward } from '../_forward.js';
export const onRequest = ({ request, env }) => forward(request, env);

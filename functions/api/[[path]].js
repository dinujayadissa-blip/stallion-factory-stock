// /api/* -> the Supabase Edge Function (see ../_forward.js)
import { forward } from '../_forward.js';
export const onRequest = ({ request, env }) => forward(request, env);

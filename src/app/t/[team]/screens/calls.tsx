"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, when } from "@/lib/client";

/**
 * Voice calls on the simulated phone. The server plays the network (ringing, busy, call records);
 * the audio goes straight from one browser to the other over WebRTC, through a relay when needed.
 */

export interface CallState {
  id: string;
  role: "caller" | "callee";
  peer: string;
  peerNetwork: string;
  status: "ringing" | "active" | "ended" | "missed" | "declined" | "busy" | "failed";
  reason: string | null;
  offer?: string;
  answer?: string;
  candidates: RTCIceCandidateInit[];
}

export interface CallLogRow {
  id: string;
  at: string;
  number: string;
  direction: "outgoing" | "incoming" | "missed";
  status: string;
  reason: string | null;
  seconds: number;
}

type AudioState = "idle" | "connecting" | "connected" | "failed";

// One identity per open tab, so a call stays with the phone that placed or answered it.
const DEVICE = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `d${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export interface Calls {
  call: CallState | null;
  audio: AudioState;
  muted: boolean;
  note: string | null;
  elsewhere: boolean;
  relay: boolean | null;
  connectedAt: number | null;
  start: (to: string) => Promise<void>;
  answer: () => Promise<void>;
  end: () => Promise<void>;
  toggleMute: () => void;
  dismiss: () => void;
}

/** Returns the call controls, and the ref for the <audio> element that plays the other person's voice. */
export function useCalls(team: string, msisdn: string): [Calls, RefObject<HTMLAudioElement | null>] {
  const [call, setCall] = useState<CallState | null>(null);
  const [audio, setAudio] = useState<AudioState>("idle");
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  const [relay, setRelay] = useState<boolean | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const callId = useRef<string | undefined>(undefined);
  const outbox = useRef<RTCIceCandidateInit[]>([]); // our network paths, not yet sent
  const inbox = useRef<RTCIceCandidateInit[]>([]); // the other phone's network paths
  const applied = useRef(0);
  const post = useCallback(<T,>(body: Record<string, unknown>) => api<T>(team, "/s/phone", { body: { ...body, msisdn, device: DEVICE } }), [team, msisdn]);

  const hangUpLocally = useCallback(() => {
    pc.current?.close();
    pc.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    callId.current = undefined;
    outbox.current = [];
    inbox.current = [];
    applied.current = 0;
    setCall(null);
    setAudio("idle");
    setMuted(false);
    setConnectedAt(null);
  }, []);

  /** Hands the other phone's network paths to the connection, once it is ready for them. */
  const applyInbox = useCallback(async () => {
    const conn = pc.current;
    if (!conn?.remoteDescription) return;
    while (applied.current < inbox.current.length) {
      const c = inbox.current[applied.current++];
      await conn.addIceCandidate(c).catch(() => undefined);
    }
  }, []);

  const connect = useCallback(async (): Promise<RTCPeerConnection> => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the microphone here. Calls need a secure (https) address.");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error("Allow microphone access to make and answer calls.");
    }
    // Asked for on every call: relay credentials are short-lived.
    const cfg = await api<{ iceServers: RTCIceServer[]; relay: boolean }>(team, "/ice").catch(() => ({ iceServers: [] as RTCIceServer[], relay: false }));
    setRelay(cfg.relay);
    const conn = new RTCPeerConnection({ iceServers: cfg.iceServers });
    pc.current = conn;
    for (const t of stream.current.getTracks()) conn.addTrack(t, stream.current);
    conn.onicecandidate = (e) => {
      if (e.candidate) outbox.current.push(e.candidate.toJSON());
    };
    conn.ontrack = (e) => {
      if (!audioRef.current) return;
      audioRef.current.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void audioRef.current.play().catch(() => undefined);
    };
    conn.onconnectionstatechange = () => {
      if (pc.current !== conn) return;
      if (conn.connectionState === "connected") {
        setAudio("connected");
        setConnectedAt((t) => t ?? Date.now());
      } else if (conn.connectionState === "failed") {
        setAudio("failed");
      }
    };
    setAudio("connecting");
    return conn;
  }, [team]);

  const end = useCallback(async () => {
    const id = callId.current;
    hangUpLocally();
    if (id) await post({ action: "call_end", callId: id }).catch(() => undefined);
  }, [hangUpLocally, post]);

  const start = useCallback(
    async (to: string) => {
      setNote(null);
      try {
        const conn = await connect();
        await conn.setLocalDescription(await conn.createOffer());
        const r = await post<{ id: string }>({ action: "call_start", to, offer: conn.localDescription?.sdp });
        callId.current = r.id;
        setCall({ id: r.id, role: "caller", peer: to, peerNetwork: "", status: "ringing", reason: null, candidates: [] });
      } catch (e) {
        hangUpLocally();
        setNote((e as Error).message);
      }
    },
    [connect, hangUpLocally, post],
  );

  const answer = useCallback(async () => {
    const current = call;
    if (!current?.offer) return;
    try {
      const conn = await connect();
      await conn.setRemoteDescription({ type: "offer", sdp: current.offer });
      await applyInbox();
      await conn.setLocalDescription(await conn.createAnswer());
      await post({ action: "call_answer", callId: current.id, answer: conn.localDescription?.sdp });
      setCall({ ...current, status: "active" });
    } catch (e) {
      const id = current.id;
      hangUpLocally();
      setNote((e as Error).message);
      await post({ action: "call_end", callId: id }).catch(() => undefined);
    }
  }, [call, connect, applyInbox, hangUpLocally, post]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      stream.current?.getAudioTracks().forEach((t) => (t.enabled = m));
      return !m;
    });
  }, []);

  // Check in with the network about once a second.
  useEffect(() => {
    if (!msisdn) return;
    let stopped = false;
    const tick = async () => {
      const sending = outbox.current.splice(0);
      try {
        const r = await post<{ call: CallState | null; elsewhere?: boolean }>({ action: "call_poll", callId: callId.current, have: inbox.current.length, candidates: sending.length ? sending : undefined });
        if (stopped) return;
        setElsewhere(!!r.elsewhere);
        const c = r.call;
        if (!c) {
          if (callId.current) hangUpLocally();
          else setCall(null);
          return;
        }
        if (c.status !== "ringing" && c.status !== "active") {
          // The call is over. Say why, unless this phone ended it itself.
          if (callId.current === c.id || c.role === "callee") setNote(c.reason ?? "Call ended");
          hangUpLocally();
          return;
        }
        callId.current = c.id;
        inbox.current.push(...c.candidates);
        if (c.role === "caller" && c.answer && pc.current && !pc.current.remoteDescription) await pc.current.setRemoteDescription({ type: "answer", sdp: c.answer });
        await applyInbox();
        setCall(c);
      } catch {
        outbox.current.unshift(...sending);
      }
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [msisdn, post, applyInbox, hangUpLocally]);

  // Switching to another line, or leaving the page, hangs up.
  useEffect(() => {
    return () => {
      const id = callId.current;
      if (id) void api(team, "/s/phone", { body: { action: "call_end", callId: id, msisdn, device: DEVICE } }).catch(() => undefined);
      pc.current?.close();
      pc.current = null;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      callId.current = undefined;
    };
  }, [team, msisdn]);

  useRingTone(call?.status === "ringing" ? call.role : null);

  return [{ call, audio, muted, note, elsewhere, relay, connectedAt, start, answer, end, toggleMute, dismiss: () => setNote(null) }, audioRef];
}

/** A ring for the phone being called, and a ringback tone for the caller. */
function useRingTone(role: "caller" | "callee" | null) {
  useEffect(() => {
    if (!role) return;
    type Ctx = typeof AudioContext;
    const Ctor: Ctx | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctx }).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    const beep = () => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = role === "callee" ? 880 : 440;
      g.gain.value = role === "callee" ? 0.12 : 0.05;
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + (role === "callee" ? 0.5 : 1));
      if (role === "callee") navigator.vibrate?.(400);
    };
    beep();
    const t = setInterval(beep, role === "callee" ? 1500 : 3000);
    return () => {
      clearInterval(t);
      void ctx.close().catch(() => undefined);
    };
  }, [role]);
}

function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Covers the phone screen while a call is ringing or in progress, as a real handset does. */
export function CallScreen({ calls }: { calls: Calls }) {
  const { call, note, audio } = calls;
  const elapsed = useElapsed(calls.connectedAt);
  if (!call) {
    if (!note) return null;
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/80 p-5">
        <div className="w-full rounded-xl bg-white p-4 text-center shadow-lg">
          <p className="text-[15px] text-gray-900">{note}</p>
          <button onClick={calls.dismiss} className="mt-4 w-full rounded-lg bg-gray-900 py-2 text-sm font-medium text-white">
            OK
          </button>
        </div>
      </div>
    );
  }
  const incoming = call.role === "callee" && call.status === "ringing";
  const status =
    call.status === "ringing"
      ? incoming
        ? "Incoming call"
        : "Calling…"
      : audio === "connected"
        ? elapsed
        : audio === "failed"
          ? "Audio could not connect"
          : "Connecting audio…";
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-between bg-gray-900 px-6 py-10 text-white">
      <div className="text-center">
        <div className="text-sm text-gray-300">{status}</div>
        <div className="mt-3 text-3xl font-semibold tracking-wide">{call.peer}</div>
        {call.peerNetwork && <div className="mt-1 text-sm text-gray-400">{call.peerNetwork}</div>}
        {audio === "failed" && (
          <p className="mx-auto mt-4 max-w-[240px] text-xs text-amber-300">
            The two phones could not reach each other. {calls.relay ? "Check the Wi-Fi connection." : "This Wi-Fi may stop phones talking directly. Ask an organiser to switch on the call relay."}
          </p>
        )}
      </div>
      <div className="flex items-center justify-center gap-8">
        {incoming ? (
          <>
            <RoundButton label="Decline" color="bg-red-600" onClick={calls.end} icon="✕" />
            <RoundButton label="Answer" color="bg-green-600" onClick={calls.answer} icon="✆" />
          </>
        ) : (
          <>
            {call.status === "active" && <RoundButton label={calls.muted ? "Unmute" : "Mute"} color={calls.muted ? "bg-white !text-gray-900" : "bg-gray-700"} onClick={calls.toggleMute} icon={calls.muted ? "🔇" : "🎙"} />}
            <RoundButton label="End call" color="bg-red-600" onClick={calls.end} icon="✕" />
          </>
        )}
      </div>
    </div>
  );
}

function RoundButton({ label, color, onClick, icon }: { label: string; color: string; onClick: () => void; icon: string }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 text-xs text-gray-300" aria-label={label}>
      <span className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl text-white shadow ${color}`}>{icon}</span>
      {label}
    </button>
  );
}

const ARROW = { outgoing: "↗", incoming: "↙", missed: "✕" };

export function CallLog({ rows, calls, onCall }: { rows: CallLogRow[]; calls: Calls; onCall: (number: string) => void }) {
  return (
    <div>
      {calls.elsewhere && <p className="bg-amber-50 px-4 py-2 text-xs text-amber-900">A call on this number is in progress on another screen.</p>}
      {rows.length === 0 ? (
        <p className="p-6 text-center text-sm text-gray-500">No calls yet. Dial a number on the Phone tab to call it.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {rows.map((c) => (
            <li key={c.id}>
              <button onClick={() => onCall(c.number)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50" aria-label={`Call ${c.number}`}>
                <span className={`w-5 text-center text-base ${c.direction === "missed" ? "text-red-600" : c.direction === "incoming" ? "text-green-700" : "text-gray-500"}`}>{ARROW[c.direction]}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm font-medium ${c.direction === "missed" ? "text-red-700" : "text-gray-900"}`}>{c.number}</span>
                  <span className="block truncate text-[11px] text-gray-500">
                    {when(c.at)} · {c.seconds ? `${Math.floor(c.seconds / 60)}m ${c.seconds % 60}s` : c.direction === "missed" ? "missed" : (c.reason ?? c.status)}
                  </span>
                </span>
                <span className="text-lg text-green-700">✆</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 py-3 text-[11px] text-gray-500">
        Calls are real audio between two phone screens. The other person must have that number&apos;s phone open.
        {calls.relay === false && " The call relay is off, so calls only connect where the Wi-Fi lets phones reach each other."}
      </p>
    </div>
  );
}

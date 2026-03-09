import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";

type Screen = "start" | "game" | "gameover";

const BEST_KEY = "tempo_tap_best_score";
const BEST_STREAK_KEY = "tempo_tap_best_streak";

const { width: SCREEN_W } = Dimensions.get("window");

const SFX = {
  hit:  require("../assets/sfx/hit.mp3"),
  // ─────────────────────────────────────────────────────────────────────
  // AUDIO FILES in assets/sfx/:
  //   bg_music.mp3      — game screen background music (loops)
  //   welcome_music.mp3 — welcome screen background music (loops)
  //   miss.mp3          — game-over screen SFX; plays on entry, stops
  //                       immediately when the user leaves the screen
  // ─────────────────────────────────────────────────────────────────────
  miss:         require("../assets/sfx/miss.mp3"),
  bgMusic:      require("../assets/sfx/bg_music.mp3"),
  welcomeMusic: require("../assets/sfx/welcome_music.mp3"),
};

const UI = {
  white: "#FFFFFF",
  white90: "rgba(255,255,255,0.9)",
  white80: "rgba(255,255,255,0.8)",
  white70: "rgba(255,255,255,0.7)",
  white60: "rgba(255,255,255,0.6)",
  white40: "rgba(255,255,255,0.40)",
  white30: "rgba(255,255,255,0.30)",
  white18: "rgba(255,255,255,0.15)",
  white12: "rgba(255,255,255,0.10)",
  pillTextPurple: "#7C3AED",
  scoreYellow: "#FBBF24",
  streakOrange: "#FB923C",
  streakRed: "#F87171",
  glow: "rgba(255,255,255,0.35)",
  green: "#22C55E",
  arc: "rgba(255,255,255,0.25)",
};

const TICK_MS = 16;
const BASE_SPEED_DEG = 1.6;
const MAX_SPEED_DEG = 6.2;

const ARC_START_DEG = 205;
const ARC_END_DEG = 335;
const ARC_SPAN = ARC_END_DEG - ARC_START_DEG;
const SAFE_WIDTH = 26;

const STREAK_TIERS = [
  { min: 3,  emoji: "🔥",  label: "ON FIRE",      multiplier: 2 },
  { min: 6,  emoji: "⚡",  label: "ELECTRIC",     multiplier: 3 },
  { min: 10, emoji: "💥",  label: "UNSTOPPABLE",  multiplier: 5 },
  { min: 15, emoji: "🌪️", label: "CHAOS MODE",   multiplier: 8 },
];

function getStreakTier(streak: number) {
  for (let i = STREAK_TIERS.length - 1; i >= 0; i--) {
    if (streak >= STREAK_TIERS[i].min) return STREAK_TIERS[i];
  }
  return null;
}

function degToRad(d: number) { return (d * Math.PI) / 180; }

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const a = degToRad(angleDeg);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end   = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function TempoTap() {
  const [screen, setScreen] = useState<Screen>("start");
  const [score,  setScore]  = useState(0);
  const [best,   setBest]   = useState(0);

  const [streak,     setStreak]     = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [milestoneTier, setMilestoneTier] = useState<typeof STREAK_TIERS[0] | null>(null);
  const lastFlashedStreakRef = useRef(-1);

  const milestoneOpacity   = useRef(new Animated.Value(0)).current;
  const milestoneScale     = useRef(new Animated.Value(0.7)).current;
  const milestoneTranslateY = useRef(new Animated.Value(20)).current;

  const angleRef      = useRef(ARC_START_DEG);
  const dirRef        = useRef<1 | -1>(1);
  const speedRef      = useRef(BASE_SPEED_DEG);
  const safeCenterRef = useRef(ARC_START_DEG + ARC_SPAN * 0.22);

  const [, forceTick] = useState(0);
  const tapLockedRef  = useRef(false);

  const tapScale   = useRef(new Animated.Value(1)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const scoreShake  = useRef(new Animated.Value(0)).current;

  const hitSoundRef     = useRef<Audio.Sound | null>(null);
  // miss is managed with the music refs so it can be stopped on demand
  const missSfxRef      = useRef<Audio.Sound | null>(null);
  const welcomeMusicRef = useRef<Audio.Sound | null>(null);
  const gameMusicRef    = useRef<Audio.Sound | null>(null);

  // ── Load hit SFX ─────────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
        });
        const hit = new Audio.Sound();
        await hit.loadAsync(SFX.hit);
        if (!mounted) { await hit.unloadAsync(); return; }
        hitSoundRef.current = hit;
      } catch {
        hitSoundRef.current = null;
      }
    })();
    return () => {
      mounted = false;
      (async () => {
        try { await hitSoundRef.current?.unloadAsync(); } catch {}
      })();
    };
  }, []);

  // ── Load music tracks + miss SFX once on mount ───────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const welcome = new Audio.Sound();
        const game    = new Audio.Sound();
        const miss    = new Audio.Sound();
        await welcome.loadAsync(SFX.welcomeMusic, { isLooping: true,  volume: 0.55 });
        await game.loadAsync(SFX.bgMusic,         { isLooping: true,  volume: 0.55 });
        await miss.loadAsync(SFX.miss,            { isLooping: false, volume: 1.0  });
        if (!mounted) {
          await welcome.unloadAsync();
          await game.unloadAsync();
          await miss.unloadAsync();
          return;
        }
        welcomeMusicRef.current = welcome;
        gameMusicRef.current    = game;
        missSfxRef.current      = miss;
        // Start welcome music from the beginning right away
        await welcome.setPositionAsync(0);
        await welcome.playAsync();
      } catch {
        welcomeMusicRef.current = null;
        gameMusicRef.current    = null;
        missSfxRef.current      = null;
      }
    })();
    return () => {
      mounted = false;
      (async () => {
        try {
          await welcomeMusicRef.current?.unloadAsync();
          await gameMusicRef.current?.unloadAsync();
          await missSfxRef.current?.unloadAsync();
        } catch {}
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── React to screen changes: stop ALL audio first, then start the right one
  useEffect(() => {
    (async () => {
      // Unconditionally stop a sound if it's loaded — no isPlaying check needed
      const stopTrack = async (sound: Audio.Sound | null) => {
        if (!sound) return;
        try {
          const status = await sound.getStatusAsync();
          if (status.isLoaded) await sound.stopAsync();
        } catch {}
      };

      // Silence everything before starting the next screen's audio
      await stopTrack(welcomeMusicRef.current);
      await stopTrack(gameMusicRef.current);
      await stopTrack(missSfxRef.current);

      try {
        if (screen === "start" && welcomeMusicRef.current) {
          await welcomeMusicRef.current.setPositionAsync(0);
          await welcomeMusicRef.current.playAsync();
        } else if (screen === "game" && gameMusicRef.current) {
          await gameMusicRef.current.setPositionAsync(0);
          await gameMusicRef.current.playAsync();
        } else if (screen === "gameover" && missSfxRef.current) {
          // Play miss SFX as game-over ambient sound — it will be stopped
          // immediately if the user taps PLAY AGAIN or BACK TO START
          await missSfxRef.current.setPositionAsync(0);
          await missSfxRef.current.playAsync();
        }
      } catch {}
    })();
  }, [screen]);

  // ── Load persisted scores ─────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const rawBest       = await AsyncStorage.getItem(BEST_KEY);
        const rawBestStreak = await AsyncStorage.getItem(BEST_STREAK_KEY);
        const n = rawBest       ? Number(rawBest)       : 0;
        const s = rawBestStreak ? Number(rawBestStreak) : 0;
        if (mounted) {
          setBest(Number.isFinite(n) ? n : 0);
          setBestStreak(Number.isFinite(s) ? s : 0);
        }
      } catch {
        if (mounted) { setBest(0); setBestStreak(0); }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const playHit = async () => { try { await hitSoundRef.current?.replayAsync(); } catch {} };

  // ── Save best scores on gameover ──────────────────────────────────────────
  useEffect(() => {
    if (screen !== "gameover") return;
    (async () => {
      try {
        const nextBest = Math.max(best, score);
        if (nextBest !== best) {
          setBest(nextBest);
          await AsyncStorage.setItem(BEST_KEY, String(nextBest));
        }
        const nextBestStreak = Math.max(bestStreak, streak);
        if (nextBestStreak !== bestStreak) {
          setBestStreak(nextBestStreak);
          await AsyncStorage.setItem(BEST_STREAK_KEY, String(nextBestStreak));
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // ── Game loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (screen !== "game") return;
    const id = setInterval(() => {
      const next = angleRef.current + dirRef.current * speedRef.current;
      if (next <= ARC_START_DEG)      { angleRef.current = ARC_START_DEG; dirRef.current = 1;  }
      else if (next >= ARC_END_DEG)   { angleRef.current = ARC_END_DEG;   dirRef.current = -1; }
      else                            { angleRef.current = next; }
      tapLockedRef.current = false;
      forceTick((x) => (x + 1) % 100000);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [screen]);

  // ── Animations ────────────────────────────────────────────────────────────
  const pulseTap = () => {
    Animated.sequence([
      Animated.timing(tapScale, { toValue: 0.94, duration: 80,  useNativeDriver: true }),
      Animated.timing(tapScale, { toValue: 1,    duration: 160, useNativeDriver: true }),
    ]).start();
  };

  const glow = () => {
    glowOpacity.setValue(0);
    Animated.sequence([
      Animated.timing(glowOpacity, { toValue: 1, duration: 80,  useNativeDriver: true }),
      Animated.timing(glowOpacity, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]).start();
  };

  const shakeScore = () => {
    Animated.sequence([
      Animated.timing(scoreShake, { toValue: -5, duration: 40, useNativeDriver: true }),
      Animated.timing(scoreShake, { toValue:  5, duration: 40, useNativeDriver: true }),
      Animated.timing(scoreShake, { toValue: -3, duration: 30, useNativeDriver: true }),
      Animated.timing(scoreShake, { toValue:  0, duration: 30, useNativeDriver: true }),
    ]).start();
  };

  // Milestone banner — uses `position: absolute` so it NEVER shifts the arc
  const flashMilestoneBanner = (tier: typeof STREAK_TIERS[0]) => {
    setMilestoneTier(tier);
    milestoneOpacity.setValue(0);
    milestoneScale.setValue(0.7);
    milestoneTranslateY.setValue(20);
    Animated.sequence([
      Animated.parallel([
        Animated.spring(milestoneScale,      { toValue: 1, useNativeDriver: true, damping: 10, stiffness: 180 }),
        Animated.timing(milestoneOpacity,    { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(milestoneTranslateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]),
      Animated.delay(1200),
      Animated.parallel([
        Animated.timing(milestoneOpacity,    { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(milestoneTranslateY, { toValue: -12, duration: 300, useNativeDriver: true }),
      ]),
    ]).start(() => setMilestoneTier(null));
  };

  // ── Game helpers ──────────────────────────────────────────────────────────
  const randomizeSafeZone = () => {
    const pad = 10;
    safeCenterRef.current = (ARC_START_DEG + pad) + Math.random() * (ARC_SPAN - pad * 2);
  };

  const updateSpeed = (nextScore: number) => {
    speedRef.current = clamp(BASE_SPEED_DEG + nextScore * 0.22, BASE_SPEED_DEG, MAX_SPEED_DEG);
  };

  const isHit = () => {
    const a    = angleRef.current;
    const half = SAFE_WIDTH / 2;
    return a >= safeCenterRef.current - half && a <= safeCenterRef.current + half;
  };

  const startGame = () => {
    setScore(0);
    setStreak(0);
    lastFlashedStreakRef.current = -1;
    angleRef.current  = ARC_START_DEG;
    dirRef.current    = 1;
    speedRef.current  = BASE_SPEED_DEG;
    randomizeSafeZone();
    tapLockedRef.current = false;
    setScreen("game");
  };

  const onTap = async () => {
    if (screen !== "game" || tapLockedRef.current) return;
    tapLockedRef.current = true;
    pulseTap();
    glow();

    const hit = isHit();
    if (!hit) {
      try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); } catch {}
      // miss SFX is played automatically when screen transitions to "gameover"
      setScreen("gameover");
      return;
    }
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    await playHit();

    setStreak((prevStreak) => {
      const nextStreak = prevStreak + 1;
      const tier = getStreakTier(nextStreak);
      if (tier && tier.min === nextStreak && lastFlashedStreakRef.current !== nextStreak) {
        lastFlashedStreakRef.current = nextStreak;
        setTimeout(() => flashMilestoneBanner(tier), 50);
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      }
      if (tier) shakeScore();
      return nextStreak;
    });

    setScore((prevScore) => {
      const currentStreak = streak + 1;
      const tier       = getStreakTier(currentStreak);
      const multiplier = tier ? tier.multiplier : 1;
      const next       = prevScore + multiplier;
      updateSpeed(next);
      randomizeSafeZone();
      return next;
    });
  };

  // ── SVG layout ────────────────────────────────────────────────────────────
  const arcSize = Math.min(SCREEN_W * 0.98, 460);
  const svgW = arcSize;
  const svgH = arcSize * 0.68;
  const cx   = svgW / 2;
  const cy   = svgH * 0.98;
  const r    = svgW * 0.40;

  const arcPath  = describeArc(cx, cy, r, ARC_START_DEG, ARC_END_DEG);
  const safeStart = safeCenterRef.current - SAFE_WIDTH / 2;
  const safeEnd   = safeCenterRef.current + SAFE_WIDTH / 2;
  const safePath  = describeArc(cx, cy, r, safeStart, safeEnd);
  const dot       = polarToCartesian(cx, cy, r, angleRef.current);
  const center    = { x: cx, y: cy };
  const speedMultiplier = (speedRef.current / BASE_SPEED_DEG).toFixed(1);

  const currentTier = getStreakTier(streak);
  const streakColor = streak >= 10 ? UI.streakRed : streak >= 3 ? UI.streakOrange : UI.white70;

  // =========================
  // Start Screen
  // =========================
  if (screen === "start") {
    return (
      <LinearGradient
        colors={["#5B21B6", "#C026D3", "#EC4899"]}
        start={{ x: 0.1, y: 0.0 }}
        end={{ x: 0.9, y: 1.0 }}
        style={styles.full}
      >
        <View style={styles.startContainer}>
          <View style={styles.titleBlock}>
            <Text style={styles.bigTitle}>TEMPO{"\n"}TAP</Text>
            <View style={styles.divider} />
            <Text style={styles.tagline}>1 Life. 1 Button.</Text>
            <Text style={styles.subText}>Tap when the line hits the zone!</Text>
          </View>

          <View style={styles.startStatsRow}>
            <View style={styles.startStatCard}>
              <Text style={styles.cardLabel}>BEST SCORE</Text>
              <Text style={styles.cardValueLarge}>{best}</Text>
            </View>
            <View style={styles.startStatCard}>
              <Text style={styles.cardLabel}>BEST STREAK</Text>
              <Text style={[styles.cardValueLarge, { color: UI.streakOrange }]}>
                {bestStreak > 0 ? `🔥${bestStreak}` : "—"}
              </Text>
            </View>
          </View>

          <Pressable
            onPress={startGame}
            style={({ pressed }) => [styles.pillBtn, pressed && styles.pressed]}
          >
            <Text style={styles.pillBtnText}>START</Text>
          </Pressable>

          <View style={styles.howToPlayBox}>
            <Text style={styles.howToPlayTitle}>HOW TO PLAY</Text>
            <Text style={styles.howToPlayText}>
              Tap the button when the moving line enters the safe zone. Build a streak for a score multiplier!
            </Text>
          </View>
        </View>
      </LinearGradient>
    );
  }

  // =========================
  // Game Over Screen
  // =========================
  if (screen === "gameover") {
    const isNewBest       = score  > 0 && score  >= best;
    const isNewBestStreak = streak > 0 && streak >= bestStreak;
    const displayBestStreak = Math.max(bestStreak, streak);
    return (
      <LinearGradient
        colors={["#EC4899", "#A855F7", "#5B21B6"]}
        start={{ x: 0.1, y: 0.0 }}
        end={{ x: 0.9, y: 1.0 }}
        style={styles.full}
      >
        {/*
          ScrollView ensures the Back To Start button is NEVER clipped,
          even on smaller screens. Content still fits without scrolling on
          typical phones because we've tightened vertical spacing.
        */}
        <ScrollView
          contentContainerStyle={styles.gameOverContainer}
          bounces={false}
          showsVerticalScrollIndicator={false}
        >
          {/* ── Title ── */}
          <Text style={styles.bigTitle}>GAME{"\n"}OVER</Text>

          {/* ── New-best badge (conditional — takes up no space if absent) ── */}
          {(isNewBest || isNewBestStreak) && (
            <View style={styles.newBestBadge}>
              <Text style={styles.newBestText}>
                {isNewBest && isNewBestStreak
                  ? "🏆 NEW BEST SCORE & STREAK!"
                  : isNewBest
                  ? "🏆 NEW BEST SCORE!"
                  : "🔥 NEW BEST STREAK!"}
              </Text>
            </View>
          )}

          {/* ── Best Score — compact row above Final Score ── */}
          <View style={styles.bestScoreSmallCard}>
            <Text style={styles.cardLabel}>BEST SCORE</Text>
            <Text style={styles.cardValueSmall}>{Math.max(best, score)}</Text>
          </View>

          {/* ── Final Score — hero card ── */}
          <View style={styles.finalScoreBigCard}>
            <Text style={styles.cardLabelLight}>FINAL SCORE</Text>
            <Text style={styles.finalScoreValue}>{score}</Text>
          </View>

          {/* ── Streak row ── */}
          <View style={styles.streakSummaryRow}>
            <View style={styles.streakSummaryCard}>
              <Text style={styles.cardLabel}>THIS RUN</Text>
              <Text style={[styles.streakSummaryValue, { color: UI.streakOrange }]}>
                🔥 {streak}
              </Text>
            </View>
            <View style={styles.streakSummaryCard}>
              <Text style={styles.cardLabel}>BEST STREAK</Text>
              <Text style={[styles.streakSummaryValue, { color: UI.streakOrange }]}>
                🔥 {displayBestStreak}
              </Text>
            </View>
          </View>

          {/* ── Buttons ── */}
          <View style={styles.buttonGroup}>
            <Pressable
              onPress={startGame}
              style={({ pressed }) => [styles.pillBtn, pressed && styles.pressed]}
            >
              <Text style={styles.pillBtnText}>PLAY AGAIN</Text>
            </Pressable>
            <Pressable
              onPress={() => setScreen("start")}
              style={({ pressed }) => [styles.pillOutlineBtn, pressed && styles.pressedSoft]}
            >
              <Text style={styles.pillOutlineText}>BACK TO START</Text>
            </Pressable>
          </View>
        </ScrollView>
      </LinearGradient>
    );
  }

  // =========================
  // Game Screen
  // =========================
  return (
    <LinearGradient
      colors={["#4C1D95", "#1D4ED8", "#0891B2"]}
      start={{ x: 0.05, y: 0.05 }}
      end={{ x: 0.95, y: 0.95 }}
      style={styles.full}
    >
      <View style={styles.gameContainer}>

        {/* ── HUD row (fixed height, never grows) ── */}
        <View style={styles.hudRow}>
          {/* Streak — left */}
          <View style={styles.streakBadge}>
            <Text style={styles.speedBadgeLabel}>STREAK</Text>
            <Text style={[styles.streakBadgeValue, { color: streakColor }]}>
              {streak > 0 ? `🔥${streak}` : "—"}
            </Text>
            {currentTier && (
              <Text style={styles.streakMultiplierLabel}>×{currentTier.multiplier}</Text>
            )}
          </View>

          {/* Score — centre */}
          <Animated.View style={[styles.scoreCenterBox, { transform: [{ translateX: scoreShake }] }]}>
            <Text style={styles.hudLabel}>SCORE</Text>
            <Text style={[
              styles.hudScoreValue,
              currentTier && { color: UI.streakOrange, textShadowColor: "rgba(251,146,60,0.5)" },
            ]}>
              {score}
            </Text>
          </Animated.View>

          {/* Speed — right */}
          <View style={styles.speedBadge}>
            <Text style={styles.speedBadgeLabel}>SPD</Text>
            <Text style={styles.speedBadgeValue}>{speedMultiplier}x</Text>
          </View>
        </View>

        {/*
          ── Arc area (flex: 1 — takes all remaining space) ──────────────────
          The milestone banner is positioned ABSOLUTELY inside this region,
          so it floats over the arc without pushing anything down.
        */}
        <View style={styles.arcWrap}>
          {/* Milestone banner — absolutely positioned, zero layout impact */}
          {milestoneTier && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.milestoneBanner,
                {
                  opacity: milestoneOpacity,
                  transform: [
                    { scale: milestoneScale },
                    { translateY: milestoneTranslateY },
                  ],
                },
              ]}
            >
              <Text style={styles.milestoneEmoji}>{milestoneTier.emoji}</Text>
              <View>
                <Text style={styles.milestoneLabel}>{milestoneTier.label}</Text>
                <Text style={styles.milestoneMultiplier}>×{milestoneTier.multiplier} SCORE MULTIPLIER</Text>
              </View>
            </Animated.View>
          )}

          <Animated.View style={{ transform: [{ scale: tapScale }] }}>
            <View style={styles.arcGlowWrap}>
              <Animated.View
                pointerEvents="none"
                style={[styles.arcGlow, { opacity: glowOpacity }]}
              />
              <Svg width={svgW} height={svgH}>
                <Path d={arcPath}  stroke="rgba(0,0,0,0.2)"       strokeWidth={18} fill="none" strokeLinecap="round" />
                <Path d={arcPath}  stroke={UI.arc}                 strokeWidth={12} fill="none" strokeLinecap="round" />
                <Path d={safePath} stroke="rgba(34,197,94,0.35)"   strokeWidth={22} fill="none" strokeLinecap="round" />
                <Path d={safePath} stroke={UI.green}               strokeWidth={13} fill="none" strokeLinecap="round" />
                <Line x1={center.x} y1={center.y} x2={dot.x} y2={dot.y} stroke="rgba(255,255,255,0.3)" strokeWidth={8} strokeLinecap="round" />
                <Line x1={center.x} y1={center.y} x2={dot.x} y2={dot.y} stroke={UI.white}              strokeWidth={5} strokeLinecap="round" />
                <Circle cx={dot.x} cy={dot.y} r={4}  fill="rgba(255,255,255,0.4)" />
                <Circle cx={dot.x} cy={dot.y} r={13} fill={UI.white} />
              </Svg>
            </View>
          </Animated.View>
        </View>

        {/* TAP button */}
        <Pressable
          onPress={onTap}
          style={({ pressed }) => [
            styles.tapBtn,
            currentTier && { borderWidth: 3, borderColor: streakColor },
            pressed && styles.tapPressed,
          ]}
        >
          <Text style={styles.tapText}>TAP</Text>
          {currentTier && (
            <Text style={[styles.tapStreakHint, { color: streakColor }]}>
              {currentTier.emoji} ×{currentTier.multiplier}
            </Text>
          )}
        </Pressable>

      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  full: { flex: 1 },

  // ── Start Screen ──────────────────────────────────────────────────────────
  startContainer: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? 56 : 44,
    paddingHorizontal: 28,
    paddingBottom: 36,
    alignItems: "center",
  },
  titleBlock: {
    alignItems: "center",
    marginBottom: 28,
  },
  bigTitle: {
    color: UI.white,
    fontSize: 62,
    fontWeight: "900",
    letterSpacing: 2,
    textAlign: "center",
    lineHeight: 64,
  },
  divider: {
    marginTop: 20,
    marginBottom: 16,
    width: 48,
    height: 3,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.45)",
  },
  tagline: {
    color: UI.white,
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  subText: {
    color: UI.white70,
    fontSize: 13,
    fontWeight: "500",
  },
  startStatsRow: {
    flexDirection: "row",
    gap: 14,
    width: "100%",
    marginBottom: 28,
  },
  startStatCard: {
    flex: 1,
    borderRadius: 20,
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  cardLabel: {
    color: UI.white60,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  cardValueLarge: {
    color: UI.white,
    fontSize: 38,
    fontWeight: "900",
    lineHeight: 44,
    marginTop: 4,
  },

  // ── How to Play ───────────────────────────────────────────────────────────
  howToPlayBox: {
    marginTop: 32,
    alignItems: "center",
    paddingHorizontal: 8,
  },
  howToPlayTitle: {
    color: UI.white60,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 2.5,
    marginBottom: 10,
  },
  howToPlayText: {
    color: UI.white70,
    fontSize: 13,
    textAlign: "center",
    lineHeight: 20,
    fontWeight: "500",
  },

  // ── Game Over Screen ──────────────────────────────────────────────────────
  gameOverContainer: {
    // Used as ScrollView contentContainerStyle — NOT flex:1 so content stacks
    paddingTop: Platform.OS === "android" ? 48 : 36,
    paddingHorizontal: 28,
    paddingBottom: 36,
    alignItems: "center",
  },
  newBestBadge: {
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  newBestText: {
    color: UI.white,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.8,
    textAlign: "center",
  },
  // Compact top card (best score)
  bestScoreSmallCard: {
    width: "55%",
    maxWidth: 200,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: "center",
    backgroundColor: UI.white12,
    borderWidth: 1,
    borderColor: UI.white12,
    marginTop: 14,
  },
  cardValueSmall: {
    color: UI.white80,
    fontSize: 26,
    fontWeight: "800",
    marginTop: 2,
  },
  // Prominent final score card
  finalScoreBigCard: {
    width: "85%",
    maxWidth: 320,
    borderRadius: 22,
    paddingVertical: 20,
    paddingHorizontal: 20,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.28)",
    marginTop: 10,
  },
  cardLabelLight: {
    color: UI.white70,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 2.5,
    textTransform: "uppercase",
  },
  finalScoreValue: {
    color: UI.scoreYellow,
    fontSize: 68,
    fontWeight: "900",
    lineHeight: 76,
    marginTop: 4,
  },
  streakSummaryRow: {
    flexDirection: "row",
    gap: 12,
    width: "85%",
    maxWidth: 320,
    marginTop: 10,
  },
  streakSummaryCard: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: UI.white12,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  streakSummaryValue: {
    fontSize: 20,
    fontWeight: "900",
    marginTop: 4,
  },
  buttonGroup: {
    width: "100%",
    marginTop: 18,
    gap: 12,
    alignItems: "center",
  },

  // ── Shared Buttons ────────────────────────────────────────────────────────
  pillBtn: {
    width: "100%",
    maxWidth: 340,
    height: 58,
    borderRadius: 999,
    backgroundColor: UI.white,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 6,
  },
  pillBtnText: {
    color: UI.pillTextPurple,
    fontSize: 17,
    fontWeight: "900",
    letterSpacing: 1.5,
  },
  pillOutlineBtn: {
    width: "100%",
    maxWidth: 340,
    height: 54,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.40)",
    alignItems: "center",
    justifyContent: "center",
  },
  pillOutlineText: {
    color: UI.white,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  pressed:     { transform: [{ scale: 0.97 }], opacity: 0.93 },
  pressedSoft: { transform: [{ scale: 0.98 }], opacity: 0.88 },

  // ── Game HUD ──────────────────────────────────────────────────────────────
  gameContainer: {
    flex: 1,
    paddingTop: Platform.OS === "android" ? 44 : 32,
    paddingHorizontal: 20,
    paddingBottom: 32,
    alignItems: "center",
  },
  hudRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    // Fixed height so HUD never resizes regardless of streak badge content
    minHeight: 72,
    marginBottom: 4,
  },
  streakBadge: {
    width: 68,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  streakBadgeValue: {
    fontSize: 14,
    fontWeight: "900",
    marginTop: 2,
  },
  streakMultiplierLabel: {
    color: UI.streakOrange,
    fontSize: 10,
    fontWeight: "900",
    marginTop: 1,
    letterSpacing: 0.5,
  },
  scoreCenterBox: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 6,
  },
  hudLabel: {
    color: UI.white60,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 2,
  },
  hudScoreValue: {
    color: UI.scoreYellow,
    fontSize: 52,
    fontWeight: "900",
    lineHeight: 56,
    marginTop: 2,
    textShadowColor: "rgba(251,191,36,0.45)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  speedBadge: {
    width: 68,
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: "center",
    backgroundColor: UI.white18,
    borderWidth: 1,
    borderColor: UI.white12,
  },
  speedBadgeLabel: {
    color: UI.white60,
    fontSize: 9,
    fontWeight: "900",
    letterSpacing: 1.5,
  },
  speedBadgeValue: {
    color: UI.white,
    fontSize: 15,
    fontWeight: "900",
    marginTop: 2,
  },

  // ── Arc wrapper ───────────────────────────────────────────────────────────
  arcWrap: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  arcGlowWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  arcGlow: {
    position: "absolute",
    width: SCREEN_W * 0.72,
    height: SCREEN_W * 0.72,
    borderRadius: 999,
    backgroundColor: UI.glow,
    opacity: 0,
  },

  // ── Milestone Banner — ABSOLUTELY POSITIONED inside arcWrap ───────────────
  milestoneBanner: {
    position: "absolute",
    top: 8,                        // sits at the top of the arc region
    alignSelf: "center",
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: "rgba(251,146,60,0.20)",
    borderWidth: 1.5,
    borderColor: "rgba(251,146,60,0.55)",
  },
  milestoneEmoji: {
    fontSize: 24,
  },
  milestoneLabel: {
    color: UI.white,
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 1,
  },
  milestoneMultiplier: {
    color: UI.streakOrange,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1,
    marginTop: 1,
  },

  // ── TAP Button ────────────────────────────────────────────────────────────
  tapBtn: {
    width: 150,
    height: 150,
    borderRadius: 999,
    backgroundColor: UI.white,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 10,
  },
  tapPressed: { transform: [{ scale: 0.96 }], opacity: 0.93 },
  tapText: {
    color: UI.pillTextPurple,
    fontSize: 22,
    fontWeight: "900",
    letterSpacing: 2,
  },
  tapStreakHint: {
    fontSize: 12,
    fontWeight: "900",
    marginTop: 2,
    letterSpacing: 0.5,
  },
});
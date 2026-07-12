// Theme registry. 20 designed token packs.
// Tokens map to existing CSS variables used across the portal.

export type ThemeMode = 'light' | 'dark';

export interface ThemeTokens {
  // Surfaces
  bg: string;          // app background
  bg2: string;         // dimmer block bg
  surface: string;     // panels/cards
  surface2: string;    // sunken / muted surface
  surfaceSunken: string;

  // Text
  ink: string;
  ink2: string;
  ink3: string;
  muted: string;

  // Lines
  line: string;
  line2: string;
  lineStrong: string;

  // Chrome (sidebar / dark band)
  navBg: string;
  navBg2: string;
  navInk: string;
  navInk2: string;
  navActive: string;
  navActiveBg: string;
  navLine: string;

  // Accent
  accent: string;
  accent2: string;       // hover
  accentSoft: string;
  accentInk: string;     // ink on accent

  // Status
  ok: string;       okSoft: string;
  warn: string;     warnSoft: string;
  danger: string;   dangerSoft: string;
  info: string;     infoSoft: string;
}

export interface Theme {
  code: string;
  name: string;
  feel: string;
  mode: ThemeMode;
  swatches: [string, string, string, string]; // bg, surface, ink, accent (for gallery chips)
  tokens: ThemeTokens;
}

// -----------------------------------------------------------------------
// 20 designed themes. Tokens carefully picked for AA contrast where the
// pairing matters (ink-on-surface, ink-on-accent, navInk-on-navBg).
// -----------------------------------------------------------------------
export const THEMES: Theme[] = [
  {
    code: 'mission-control', name: 'Mission Control',
    feel: 'Control center. Deep navy, graphite, electric green.',
    mode: 'dark',
    swatches: ['#0a1020','#10182a','#e6ebf5','#5ce386'],
    tokens: {
      bg:'#0a1020', bg2:'#0d1426', surface:'#10182a', surface2:'#152038', surfaceSunken:'#0c1224',
      ink:'#e6ebf5', ink2:'#c1c8db', ink3:'#9099b3', muted:'#6c7593',
      line:'#1d2746', line2:'#162042', lineStrong:'#2a365a',
      navBg:'#070b18', navBg2:'#0d1426', navInk:'#bcc4dc', navInk2:'#7a83a0',
      navActive:'#ffffff', navActiveBg:'#162042', navLine:'#172244',
      accent:'#5ce386', accent2:'#7eed9f', accentSoft:'#163d22', accentInk:'#dff7e6',
      ok:'#5ce386', okSoft:'#143323', warn:'#f0c46d', warnSoft:'#3a2a0d',
      danger:'#ff7a7a', dangerSoft:'#3a1010', info:'#7ec0ff', infoSoft:'#0e2540',
    },
  },
  {
    code: 'editorial', name: 'Editorial',
    feel: 'Premium magazine. Warm white, ink, sage.',
    mode: 'light',
    swatches: ['#f4f1ea','#ffffff','#15192b','#a37a3d'],
    tokens: {
      bg:'#f4f1ea', bg2:'#ebe6d8', surface:'#ffffff', surface2:'#faf7ef', surfaceSunken:'#efeadb',
      ink:'#15192b', ink2:'#2f3548', ink3:'#555c70', muted:'#7d8497',
      line:'#ddd5c4', line2:'#ece6d4', lineStrong:'#c0b6a0',
      navBg:'#15192b', navBg2:'#1c2138', navInk:'#b9bfd1', navInk2:'#828aa3',
      navActive:'#ffffff', navActiveBg:'#252b48', navLine:'#2a304d',
      accent:'#a37a3d', accent2:'#8c6628', accentSoft:'#f2e7cf', accentInk:'#4e3a17',
      ok:'#1d6a3f', okSoft:'#e0efe4', warn:'#8a6300', warnSoft:'#faecc7',
      danger:'#8e2222', dangerSoft:'#f4dada', info:'#1c4f7a', infoSoft:'#e1ecf5',
    },
  },
  {
    code: 'midnight', name: 'Midnight',
    feel: 'Calm dark with cyan signal.',
    mode: 'dark',
    swatches: ['#0b1116','#10171f','#e5edf2','#6ad7d7'],
    tokens: {
      bg:'#0b1116', bg2:'#0e151d', surface:'#10171f', surface2:'#161e28', surfaceSunken:'#0d141c',
      ink:'#e5edf2', ink2:'#c0cad2', ink3:'#8e98a2', muted:'#6b7480',
      line:'#1d2530', line2:'#161e28', lineStrong:'#2a3340',
      navBg:'#070b10', navBg2:'#0e151d', navInk:'#bcc4cf', navInk2:'#79828c',
      navActive:'#ffffff', navActiveBg:'#152130', navLine:'#172230',
      accent:'#6ad7d7', accent2:'#83e3e3', accentSoft:'#10303a', accentInk:'#ddf1f1',
      ok:'#6dd3a3', okSoft:'#102a22', warn:'#e6c46c', warnSoft:'#332608',
      danger:'#f08383', dangerSoft:'#341212', info:'#7cc6ec', infoSoft:'#0e2740',
    },
  },
  {
    code: 'aurora', name: 'Aurora',
    feel: 'Dark with emerald + soft blue gradient signal.',
    mode: 'dark',
    swatches: ['#0a1414','#0f1c1c','#e2efe8','#3fc28d'],
    tokens: {
      bg:'#0a1414', bg2:'#0d1a1a', surface:'#0f1c1c', surface2:'#152525', surfaceSunken:'#0c1818',
      ink:'#e2efe8', ink2:'#b8c9c0', ink3:'#849689', muted:'#5d6c63',
      line:'#1a2b29', line2:'#152525', lineStrong:'#26403c',
      navBg:'#060f0f', navBg2:'#0d1a1a', navInk:'#b0c4ba', navInk2:'#788d80',
      navActive:'#ffffff', navActiveBg:'#142926', navLine:'#152b27',
      accent:'#3fc28d', accent2:'#5cd6a1', accentSoft:'#0f2e24', accentInk:'#ddf0e7',
      ok:'#3fc28d', okSoft:'#0f2e24', warn:'#e0b76e', warnSoft:'#2f240b',
      danger:'#e57b7b', dangerSoft:'#2e1010', info:'#7eb6e5', infoSoft:'#0d2438',
    },
  },
  {
    code: 'paper-studio', name: 'Paper Studio',
    feel: 'Cream paper, charcoal ink, olive accent.',
    mode: 'light',
    swatches: ['#f8f4e9','#ffffff','#1b1b1b','#6c7548'],
    tokens: {
      bg:'#f8f4e9', bg2:'#efe9d6', surface:'#ffffff', surface2:'#fbf8ee', surfaceSunken:'#f2ebd6',
      ink:'#1b1b1b', ink2:'#3a3a39', ink3:'#5f5f5d', muted:'#7d7c78',
      line:'#dad4be', line2:'#ebe4cb', lineStrong:'#b8b099',
      navBg:'#1b1b1b', navBg2:'#262625', navInk:'#c2c0b7', navInk2:'#84827b',
      navActive:'#ffffff', navActiveBg:'#2e2e2c', navLine:'#2a2a28',
      accent:'#6c7548', accent2:'#586038', accentSoft:'#e6e8d2', accentInk:'#2b3019',
      ok:'#3d6b3a', okSoft:'#e3edd9', warn:'#8a6300', warnSoft:'#f7e8c2',
      danger:'#8e2c22', dangerSoft:'#f3dad6', info:'#385f7a', infoSoft:'#dfe9f0',
    },
  },
  {
    code: 'slate', name: 'Slate',
    feel: 'Blue gray with teal signal.',
    mode: 'light',
    swatches: ['#eaeef2','#ffffff','#16202b','#2f8c8a'],
    tokens: {
      bg:'#eaeef2', bg2:'#dde3ea', surface:'#ffffff', surface2:'#f3f6fa', surfaceSunken:'#e2e8ee',
      ink:'#16202b', ink2:'#2c3845', ink3:'#566270', muted:'#7a8595',
      line:'#cdd6e0', line2:'#dfe5ed', lineStrong:'#a9b4c2',
      navBg:'#16202b', navBg2:'#1d2937', navInk:'#bbc6d4', navInk2:'#7f8a9c',
      navActive:'#ffffff', navActiveBg:'#26344a', navLine:'#22303f',
      accent:'#2f8c8a', accent2:'#247371', accentSoft:'#d6ecea', accentInk:'#0e3030',
      ok:'#22855a', okSoft:'#dcefe2', warn:'#a26d00', warnSoft:'#fbe9c2',
      danger:'#9a2727', dangerSoft:'#f3d9d9', info:'#26618a', infoSoft:'#dceaf3',
    },
  },
  {
    code: 'carbon', name: 'Carbon',
    feel: 'Near-black with steel + signal green.',
    mode: 'dark',
    swatches: ['#0f1112','#161819','#e8ebec','#52d39a'],
    tokens: {
      bg:'#0f1112', bg2:'#121415', surface:'#161819', surface2:'#1e2122', surfaceSunken:'#101213',
      ink:'#e8ebec', ink2:'#c1c5c8', ink3:'#8b9092', muted:'#62686b',
      line:'#23282b', line2:'#1c2023', lineStrong:'#333b40',
      navBg:'#08090a', navBg2:'#121415', navInk:'#bcc2c5', navInk2:'#777e83',
      navActive:'#ffffff', navActiveBg:'#1c2126', navLine:'#1a1d20',
      accent:'#52d39a', accent2:'#6ee0ad', accentSoft:'#10301f', accentInk:'#dff5e6',
      ok:'#52d39a', okSoft:'#10301f', warn:'#e0bd66', warnSoft:'#332408',
      danger:'#ee7c7c', dangerSoft:'#321212', info:'#7fb8e0', infoSoft:'#0e2638',
    },
  },
  {
    code: 'ocean', name: 'Ocean',
    feel: 'Deep blue water with turquoise.',
    mode: 'dark',
    swatches: ['#081a2e','#0d2440','#e8f2ff','#3ec6c0'],
    tokens: {
      bg:'#081a2e', bg2:'#0a213a', surface:'#0d2440', surface2:'#13304e', surfaceSunken:'#0a213a',
      ink:'#e8f2ff', ink2:'#c1d2e8', ink3:'#89a0bd', muted:'#637b99',
      line:'#193156', line2:'#13294a', lineStrong:'#264272',
      navBg:'#06142a', navBg2:'#0c1f3a', navInk:'#b6c8e3', navInk2:'#7589a8',
      navActive:'#ffffff', navActiveBg:'#143058', navLine:'#152e54',
      accent:'#3ec6c0', accent2:'#5ed6d0', accentSoft:'#0d3735', accentInk:'#ddefee',
      ok:'#52cf9a', okSoft:'#0e3023', warn:'#e8c46d', warnSoft:'#33260b',
      danger:'#ee8181', dangerSoft:'#341515', info:'#7fb6ff', infoSoft:'#102648',
    },
  },
  {
    code: 'forest', name: 'Forest',
    feel: 'Dark green pine with warm stone.',
    mode: 'dark',
    swatches: ['#0d1612','#11201a','#ebefe8','#b89a55'],
    tokens: {
      bg:'#0d1612', bg2:'#0f1d17', surface:'#11201a', surface2:'#172a22', surfaceSunken:'#0f1d17',
      ink:'#ebefe8', ink2:'#c1cabd', ink3:'#8c9788', muted:'#6a7568',
      line:'#1c2e26', line2:'#142a21', lineStrong:'#2b4338',
      navBg:'#08120e', navBg2:'#0f1d17', navInk:'#b3c0b3', navInk2:'#7a877a',
      navActive:'#ffffff', navActiveBg:'#15291f', navLine:'#142820',
      accent:'#b89a55', accent2:'#cdb070', accentSoft:'#382f17', accentInk:'#f5ead5',
      ok:'#69c188', okSoft:'#10311e', warn:'#e0c46d', warnSoft:'#322608',
      danger:'#e07d7d', dangerSoft:'#2f1212', info:'#80b6cf', infoSoft:'#102633',
    },
  },
  {
    code: 'warm-terminal', name: 'Warm Terminal',
    feel: 'Warm black with orange phosphor.',
    mode: 'dark',
    swatches: ['#15110d','#1d1813','#f0e7d8','#ff9b3a'],
    tokens: {
      bg:'#15110d', bg2:'#1a1510', surface:'#1d1813', surface2:'#27201a', surfaceSunken:'#181410',
      ink:'#f0e7d8', ink2:'#cdc3b1', ink3:'#94896f', muted:'#6a6048',
      line:'#28211a', line2:'#1d1813', lineStrong:'#3d3527',
      navBg:'#0d0a07', navBg2:'#1a1510', navInk:'#c5b8a0', navInk2:'#807461',
      navActive:'#ffffff', navActiveBg:'#241c14', navLine:'#1d1813',
      accent:'#ff9b3a', accent2:'#ffb058', accentSoft:'#3a2410', accentInk:'#ffe7ce',
      ok:'#74c98e', okSoft:'#16331c', warn:'#ffd166', warnSoft:'#3a2a08',
      danger:'#ff7e7e', dangerSoft:'#341010', info:'#8ec4ee', infoSoft:'#102640',
    },
  },
  {
    code: 'graphite', name: 'Graphite',
    feel: 'Calm gray with disciplined blue.',
    mode: 'light',
    swatches: ['#ecedee','#ffffff','#1b1f23','#3b6fbd'],
    tokens: {
      bg:'#ecedee', bg2:'#dfe1e3', surface:'#ffffff', surface2:'#f5f6f7', surfaceSunken:'#e4e6e7',
      ink:'#1b1f23', ink2:'#33383e', ink3:'#5b6168', muted:'#7e848b',
      line:'#cdd0d3', line2:'#dee0e2', lineStrong:'#abb0b6',
      navBg:'#1b1f23', navBg2:'#252a30', navInk:'#bdc2c8', navInk2:'#828891',
      navActive:'#ffffff', navActiveBg:'#2b3138', navLine:'#252a30',
      accent:'#3b6fbd', accent2:'#2c599e', accentSoft:'#dde7f5', accentInk:'#0e2444',
      ok:'#2a8156', okSoft:'#dceee3', warn:'#9d6800', warnSoft:'#f9e5bd',
      danger:'#9c2a2a', dangerSoft:'#f3d7d7', info:'#2a5d8a', infoSoft:'#dcebf3',
    },
  },
  {
    code: 'sunset', name: 'Sunset',
    feel: 'Warm dusk with coral accent.',
    mode: 'light',
    swatches: ['#fbf1ea','#ffffff','#241917','#c25a4e'],
    tokens: {
      bg:'#fbf1ea', bg2:'#f3e3d4', surface:'#ffffff', surface2:'#fdf6f0', surfaceSunken:'#f6e8d9',
      ink:'#241917', ink2:'#3f2f2c', ink3:'#675652', muted:'#897770',
      line:'#e4cdba', line2:'#f0dec9', lineStrong:'#caa787',
      navBg:'#241917', navBg2:'#312220', navInk:'#cfc2bd', navInk2:'#8e7e79',
      navActive:'#ffffff', navActiveBg:'#3a2925', navLine:'#312220',
      accent:'#c25a4e', accent2:'#a64639', accentSoft:'#f7d9d3', accentInk:'#3e1611',
      ok:'#3a7d52', okSoft:'#e2efe2', warn:'#9b5b00', warnSoft:'#fbe2bd',
      danger:'#9a2727', dangerSoft:'#f4d8d8', info:'#34607b', infoSoft:'#dee9ee',
    },
  },
  {
    code: 'minimal-white', name: 'Minimal White',
    feel: 'Near-white surfaces, black ink, restrained.',
    mode: 'light',
    swatches: ['#fafafa','#ffffff','#0d0d0d','#1a1a1a'],
    tokens: {
      bg:'#fafafa', bg2:'#f1f1f1', surface:'#ffffff', surface2:'#f6f6f6', surfaceSunken:'#ededed',
      ink:'#0d0d0d', ink2:'#26262a', ink3:'#5a5a5e', muted:'#80808a',
      line:'#e2e2e4', line2:'#eeeeef', lineStrong:'#bcbcbf',
      navBg:'#0d0d0d', navBg2:'#1a1a1a', navInk:'#bdbdbf', navInk2:'#7e7e83',
      navActive:'#ffffff', navActiveBg:'#222222', navLine:'#1a1a1a',
      accent:'#1a1a1a', accent2:'#000000', accentSoft:'#e8e8ea', accentInk:'#0d0d0d',
      ok:'#1e7a45', okSoft:'#dcefe1', warn:'#8a6300', warnSoft:'#f4e3b8',
      danger:'#8e2222', dangerSoft:'#f1d6d6', info:'#1c4f7a', infoSoft:'#dde7ef',
    },
  },
  {
    code: 'clay', name: 'Clay',
    feel: 'Beige clay with terracotta accent.',
    mode: 'light',
    swatches: ['#f3ece1','#ffffff','#262017','#b85a32'],
    tokens: {
      bg:'#f3ece1', bg2:'#ebe1cf', surface:'#ffffff', surface2:'#faf3e7', surfaceSunken:'#ede2cb',
      ink:'#262017', ink2:'#3e3528', ink3:'#665a45', muted:'#897e63',
      line:'#dccdb1', line2:'#ebdfc5', lineStrong:'#b8a684',
      navBg:'#262017', navBg2:'#332b1f', navInk:'#cdc5b1', navInk2:'#8a8170',
      navActive:'#ffffff', navActiveBg:'#3a3122', navLine:'#332b1f',
      accent:'#b85a32', accent2:'#9b4720', accentSoft:'#f4d9c8', accentInk:'#3a160b',
      ok:'#406d3f', okSoft:'#e0ecd7', warn:'#9d6800', warnSoft:'#f9e5bd',
      danger:'#8e2222', dangerSoft:'#f0d2d2', info:'#3e607b', infoSoft:'#dee7ee',
    },
  },
  {
    code: 'monolith', name: 'Monolith',
    feel: 'Black stone with gold leaf.',
    mode: 'dark',
    swatches: ['#0c0c0c','#141414','#e9e7df','#c7a657'],
    tokens: {
      bg:'#0c0c0c', bg2:'#101010', surface:'#141414', surface2:'#1c1c1c', surfaceSunken:'#0e0e0e',
      ink:'#e9e7df', ink2:'#c5c2b5', ink3:'#90897b', muted:'#69635a',
      line:'#262522', line2:'#1c1c1c', lineStrong:'#363430',
      navBg:'#070707', navBg2:'#121212', navInk:'#c0bdb2', navInk2:'#7b7669',
      navActive:'#ffffff', navActiveBg:'#1f1f1d', navLine:'#181816',
      accent:'#c7a657', accent2:'#b6953f', accentSoft:'#3b3017', accentInk:'#f5e6c0',
      ok:'#7bc28a', okSoft:'#15301c', warn:'#e2c277', warnSoft:'#322507',
      danger:'#ea8484', dangerSoft:'#321111', info:'#85b9e4', infoSoft:'#0f2640',
    },
  },
  {
    code: 'arctic', name: 'Arctic',
    feel: 'Ice light with navy.',
    mode: 'light',
    swatches: ['#eef4f8','#ffffff','#0e2235','#2c5a9c'],
    tokens: {
      bg:'#eef4f8', bg2:'#e0eaf2', surface:'#ffffff', surface2:'#f3f7fb', surfaceSunken:'#e5edf4',
      ink:'#0e2235', ink2:'#22384c', ink3:'#4b5e72', muted:'#74859b',
      line:'#cad8e3', line2:'#dde7ef', lineStrong:'#a4b6c8',
      navBg:'#0e2235', navBg2:'#172c41', navInk:'#bccae0', navInk2:'#7587a0',
      navActive:'#ffffff', navActiveBg:'#1c3550', navLine:'#1a3046',
      accent:'#2c5a9c', accent2:'#1f4684', accentSoft:'#dceaf6', accentInk:'#0a1f3a',
      ok:'#27875e', okSoft:'#dbf0e2', warn:'#9a6500', warnSoft:'#f8e1ba',
      danger:'#9a2727', dangerSoft:'#f3d9d9', info:'#26618a', infoSoft:'#dceaf3',
    },
  },
  {
    code: 'studio', name: 'Studio',
    feel: 'White studio with deep green.',
    mode: 'light',
    swatches: ['#f4f6f3','#ffffff','#101512','#2a6b4d'],
    tokens: {
      bg:'#f4f6f3', bg2:'#e6ebe7', surface:'#ffffff', surface2:'#f7faf7', surfaceSunken:'#ebefeb',
      ink:'#101512', ink2:'#222a26', ink3:'#525a55', muted:'#7c857f',
      line:'#cfd8d2', line2:'#e0e8e2', lineStrong:'#aab6af',
      navBg:'#101512', navBg2:'#1a201b', navInk:'#bcc4be', navInk2:'#7f8780',
      navActive:'#ffffff', navActiveBg:'#1d2520', navLine:'#1a201b',
      accent:'#2a6b4d', accent2:'#1d553a', accentSoft:'#dcecde', accentInk:'#0a2418',
      ok:'#2a8156', okSoft:'#dbeee0', warn:'#9d6800', warnSoft:'#f8e3ba',
      danger:'#8e2222', dangerSoft:'#f1d4d4', info:'#26618a', infoSoft:'#dcebf3',
    },
  },
  {
    code: 'cobalt', name: 'Cobalt',
    feel: 'Blue with crisp white.',
    mode: 'light',
    swatches: ['#eef1f7','#ffffff','#0c1a36','#2a4be6'],
    tokens: {
      bg:'#eef1f7', bg2:'#e0e6f1', surface:'#ffffff', surface2:'#f3f5fb', surfaceSunken:'#e6ebf4',
      ink:'#0c1a36', ink2:'#1f2b48', ink3:'#4b5876', muted:'#737e9b',
      line:'#cdd3e1', line2:'#dee3ec', lineStrong:'#a6aebf',
      navBg:'#0c1a36', navBg2:'#142345', navInk:'#bdc4d9', navInk2:'#727b9b',
      navActive:'#ffffff', navActiveBg:'#1a2c54', navLine:'#172749',
      accent:'#2a4be6', accent2:'#1d39c2', accentSoft:'#dde2fa', accentInk:'#070d1f',
      ok:'#27875e', okSoft:'#dbf0e2', warn:'#9a6500', warnSoft:'#f7e1ba',
      danger:'#9a2727', dangerSoft:'#f3d9d9', info:'#1d4f8a', infoSoft:'#dde6f3',
    },
  },
  {
    code: 'nord', name: 'Nord',
    feel: 'Cold gray sky with frost blue.',
    mode: 'light',
    swatches: ['#eceff4','#ffffff','#2e3440','#5e81ac'],
    tokens: {
      bg:'#eceff4', bg2:'#e0e4ec', surface:'#ffffff', surface2:'#f4f6fa', surfaceSunken:'#e6eaf2',
      ink:'#2e3440', ink2:'#3b4252', ink3:'#4c566a', muted:'#7a8294',
      line:'#d2d8e1', line2:'#e1e5ec', lineStrong:'#aab2bf',
      navBg:'#2e3440', navBg2:'#3b4252', navInk:'#d8dee9', navInk2:'#8b94a4',
      navActive:'#ffffff', navActiveBg:'#434c5e', navLine:'#3b4252',
      accent:'#5e81ac', accent2:'#4f6f95', accentSoft:'#dde5ee', accentInk:'#1d2a3c',
      ok:'#a3be8c', okSoft:'#e6efdc', warn:'#ebcb8b', warnSoft:'#f6ecd0',
      danger:'#bf616a', dangerSoft:'#f3d8db', info:'#88c0d0', infoSoft:'#e0edf2',
    },
  },
  {
    code: 'signal', name: 'Signal',
    feel: 'Black operator with bright green.',
    mode: 'dark',
    swatches: ['#000000','#0a0a0a','#e6f4e6','#2bd45a'],
    tokens: {
      bg:'#000000', bg2:'#070707', surface:'#0a0a0a', surface2:'#121212', surfaceSunken:'#0a0a0a',
      ink:'#e6f4e6', ink2:'#bcd1bc', ink3:'#8aa18a', muted:'#5d705d',
      line:'#1d2a1d', line2:'#152015', lineStrong:'#2a3d2a',
      navBg:'#000000', navBg2:'#0a0a0a', navInk:'#bbd0bb', navInk2:'#778877',
      navActive:'#ffffff', navActiveBg:'#0f1a0f', navLine:'#0c160c',
      accent:'#2bd45a', accent2:'#4ee175', accentSoft:'#0d2e16', accentInk:'#e0ffe6',
      ok:'#2bd45a', okSoft:'#0d2e16', warn:'#e8c054', warnSoft:'#2f2406',
      danger:'#ff7676', dangerSoft:'#2c0d0d', info:'#7cb6ff', infoSoft:'#0d2244',
    },
  },
];

export const DEFAULT_THEME = 'mission-control';

export function themeByCode(code: string | null | undefined): Theme {
  if (!code) return THEMES[0];
  return THEMES.find((t) => t.code === code) ?? THEMES[0];
}

// Build a CSS rule body from a theme.
function rule(theme: Theme): string {
  const t = theme.tokens;
  return `
  --bg: ${t.bg}; --bg-2: ${t.bg2};
  --surface: ${t.surface}; --surface-2: ${t.surface2}; --surface-sunken: ${t.surfaceSunken};
  --ink: ${t.ink}; --ink-2: ${t.ink2}; --ink-3: ${t.ink3}; --muted: ${t.muted};
  --line: ${t.line}; --line-2: ${t.line2}; --line-strong: ${t.lineStrong};
  --nav-bg: ${t.navBg}; --nav-bg-2: ${t.navBg2};
  --nav-ink: ${t.navInk}; --nav-ink-2: ${t.navInk2};
  --nav-active: ${t.navActive}; --nav-active-bg: ${t.navActiveBg}; --nav-line: ${t.navLine};
  --accent: ${t.accent}; --accent-2: ${t.accent2}; --accent-soft: ${t.accentSoft}; --accent-ink: ${t.accentInk};
  --ok: ${t.ok}; --ok-soft: ${t.okSoft};
  --warn: ${t.warn}; --warn-soft: ${t.warnSoft};
  --danger: ${t.danger}; --danger-soft: ${t.dangerSoft};
  --info: ${t.info}; --info-soft: ${t.infoSoft};
  color-scheme: ${theme.mode === 'dark' ? 'dark' : 'light'};
`.trim();
}

// Produce one big stylesheet that declares every theme as `[data-theme=<code>]`.
// Imported by SSR to inject as <style id="email-platform-themes">.
export function allThemesCss(): string {
  const def = THEMES.find((t) => t.code === DEFAULT_THEME)!;
  let css = `:root { ${rule(def)} }\n`;
  for (const t of THEMES) css += `:root[data-theme="${t.code}"] { ${rule(t)} }\n`;
  return css;
}

// AA contrast helper (server-side check; kept simple, no WCAG-4 nuance).
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const c = [r, g, b].map((x) => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a) + 0.05;
  const lb = relativeLuminance(b) + 0.05;
  return la > lb ? la / lb : lb / la;
}
export function themeContrastSummary(t: Theme) {
  const pairs = [
    ['ink/surface',  contrastRatio(t.tokens.ink, t.tokens.surface)],
    ['ink/bg',       contrastRatio(t.tokens.ink, t.tokens.bg)],
    ['navInk/navBg', contrastRatio(t.tokens.navInk, t.tokens.navBg)],
    ['accentInk/accent', contrastRatio(t.tokens.accentInk, t.tokens.accent)],
  ] as const;
  return pairs.map(([k, v]) => ({ pair: k, ratio: Math.round(v * 100) / 100, passAA: v >= 4.5 }));
}

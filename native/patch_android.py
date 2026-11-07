#!/usr/bin/env python3
"""
Run by GitHub Actions after `npx cap add android`.
Copies our native Java code into the generated Android project, adds the
permissions/service/receiver to AndroidManifest.xml, sets the version and
replaces the launcher icons with ours.
"""
import os, re, shutil, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, 'android', 'app')
PKG_DIR = os.path.join(APP, 'src', 'main', 'java', 'com', 'm9r1u5', 'parkfinder')
RES = os.path.join(APP, 'src', 'main', 'res')
MANIFEST = os.path.join(APP, 'src', 'main', 'AndroidManifest.xml')

# 1. Java sources (overwrites the generated MainActivity)
os.makedirs(PKG_DIR, exist_ok=True)
for f in glob.glob(os.path.join(ROOT, 'native', '*.java')):
    shutil.copy(f, PKG_DIR)
    print('copied', os.path.basename(f))

# 2. Manifest
m = open(MANIFEST, encoding='utf-8').read()
perms = [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.ACTIVITY_RECOGNITION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_HEALTH',
    'android.permission.FOREGROUND_SERVICE_LOCATION',
    'android.permission.HIGH_SAMPLING_RATE_SENSORS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK',
    'android.permission.VIBRATE',
    'android.permission.CAMERA',
]
add = ''.join(f'    <uses-permission android:name="{p}" />\n' for p in perms if p not in m)
add += '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n'
add += '    <uses-feature android:name="android.hardware.location.gps" android:required="false" />\n'
add += '    <uses-feature android:name="android.hardware.sensor.barometer" android:required="false" />\n'
add += '    <uses-feature android:name="android.hardware.sensor.stepdetector" android:required="false" />\n'
m = m.replace('</manifest>', add + '</manifest>')

components = '''
        <service
            android:name=".ParkTrackerService"
            android:exported="false"
            android:foregroundServiceType="health|location" />
        <receiver
            android:name=".ReminderReceiver"
            android:exported="false" />
'''
if 'ParkTrackerService' not in m:
    m = m.replace('</application>', components + '    </application>')
open(MANIFEST, 'w', encoding='utf-8').write(m)
print('manifest patched')

# 3. Version
gradle = os.path.join(APP, 'build.gradle')
g = open(gradle, encoding='utf-8').read()
code = os.environ.get('VERSION_CODE', '1')
name = os.environ.get('VERSION_NAME', '1.0.0')
g = re.sub(r'versionCode\s+\d+', f'versionCode {code}', g)
g = re.sub(r'versionName\s+"[^"]*"', f'versionName "{name}"', g)
open(gradle, 'w', encoding='utf-8').write(g)
print('version', name, code)

# 3b. Always sign with the SAME key (native/parkfinder.keystore).
# GitHub makes a new random debug key on every run, and Android refuses to
# install an update signed with a different key ("App not installed").
ks = os.path.join(ROOT, 'native', 'parkfinder.keystore').replace('\\', '/')
g = open(gradle, encoding='utf-8').read()
if 'parkfinder.keystore' not in g:
    sign = (
        "android {\n"
        "    signingConfigs {\n"
        "        debug {\n"
        f"            storeFile file('{ks}')\n"
        "            storePassword 'parkfinder'\n"
        "            keyAlias 'parkfinder'\n"
        "            keyPassword 'parkfinder'\n"
        "        }\n"
        "    }\n"
    )
    g = g.replace('android {\n', sign, 1)
    open(gradle, 'w', encoding='utf-8').write(g)
    print('fixed signing key set')

# 4. Notification icon (white "P" in a rounded square, vector)
os.makedirs(os.path.join(RES, 'drawable'), exist_ok=True)
open(os.path.join(RES, 'drawable', 'ic_stat_park.xml'), 'w').write('''<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF"
        android:pathData="M6,3h12a3,3 0,0 1,3 3v12a3,3 0,0 1,-3 3H6a3,3 0,0 1,-3 -3V6a3,3 0,0 1,3 -3zM9,7v10h2.2v-3.3h2.1c2.1,0 3.5,-1.3 3.5,-3.35S15.4,7 13.3,7zM11.2,8.9h1.9c0.9,0 1.5,0.55 1.5,1.45s-0.6,1.45 -1.5,1.45h-1.9z"/>
</vector>
''')

# 5. Launcher icons
try:
    from PIL import Image
    src = Image.open(os.path.join(ROOT, 'icons', 'icon-1024.png')).convert('RGBA')
    sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    fg_sizes = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
    for d, s in sizes.items():
        folder = os.path.join(RES, f'mipmap-{d}')
        os.makedirs(folder, exist_ok=True)
        img = src.resize((s, s), Image.LANCZOS)
        img.save(os.path.join(folder, 'ic_launcher.png'))
        img.save(os.path.join(folder, 'ic_launcher_round.png'))
        fs = fg_sizes[d]
        img.resize((fs, fs), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher_foreground.png'))
    # adaptive icon background colour = our dark background
    vals = os.path.join(RES, 'values', 'ic_launcher_background.xml')
    open(vals, 'w').write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F1216</color>\n</resources>\n')
    print('icons replaced')
except Exception as e:
    print('icon step skipped:', e)

const { rcedit } = require('rcedit');
const path = require('path');

async function setIcon() {
    try {
        const exePath = path.join(__dirname, 'steve-classroom-mode.exe');
        const iconPath = path.join(__dirname, 'favicon', 'favicon-128x128.ico');
        
        console.log(`Setting icon for ${exePath} using ${iconPath}`);
        await rcedit(exePath, {
            icon: iconPath
        });
        console.log('Successfully set the .exe icon!');
    } catch (err) {
        console.error('Failed to set .exe icon:', err);
    }
}

setIcon();

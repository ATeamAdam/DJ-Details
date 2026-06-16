Install Required Software

Ensure the target computer has the necessary software installed:

Node.js and npm

sudo apt-get update
sudo apt-get install -y nodejs npm
SQLite3

sudo apt-get install -y sqlite3


Transfer Your Project Files
Transfer your project files to the target computer. You can use a USB drive, cloud storage, or a file transfer tool like SCP. Ensure the following files and folders are included:

package.json
package-lock.json
server.js
scraper.js
updateDJData.js
database.js
djs.db
public folder containing index.html, script.js, styles.css, and the assets folder


Navigate to Your Project Directory
Open a terminal and navigate to the directory where your project files are located:

cd /path/to/your/project


Install Node.js Dependencies
Run the following command to install the necessary Node.js dependencies:

npm install


Set Up the SQLite Database
Run the following command:

node database.js

When everything has been installed run:

node server.js

then open a browser and naviagte to:

localhost:3000
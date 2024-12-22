const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const bodyParser = require('body-parser');
// const mongoose = require('./db'); // MongoDB connection
const NodeCache = require('node-cache');
const SensorMeta = require('./models/SensorMetadata')
const sensor = require('./models/sensor')
const fs = require('fs');
const mongoose = require('mongoose');
const { spawn } = require('child_process');

// MongoDB connection
const MONGO_URI = 'mongodb://localhost:27017/sensorDB';
mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

const db = mongoose.connection;

const userRoutes = require('./routes/user');

const createSchema = () => new mongoose.Schema({}, { strict: false }); // Schema for dynamic collections

const getModel = (collectionName) => {
    if (mongoose.models[collectionName]) {
        return mongoose.models[collectionName];
    }
    return mongoose.model(collectionName, createSchema(), collectionName);
};

// Function to call the Python script
function processLinesWithPython(lines) {
    console.log('lim',lines)
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', ['./processing&detection.py', lines]);
        let result = '';

        pythonProcess.stdout.on('data', (data) => {
            result += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            console.error(`Python Error: ${data}`);
        });

        pythonProcess.on('close', (code) => {
            if (code === 0) {
                resolve(result.trim());
            } else {
                reject(new Error(`Python script exited with code ${code}`));
            }
        });
    });
}

// Function to call the Python script
function decrypt(arg1,arg2) {
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn('python', ['./process_messages.py', arg1,arg2]);

        let output = '';  // Variable to accumulate the output

        // Collect data from Python script's stdout
        pythonProcess.stdout.on('data', (data) => {
            output += data.toString();
        });

        // Handle any errors from the Python script
        pythonProcess.stderr.on('data', (data) => {
            reject(`Python error: ${data.toString()}`);
        });

        // When the Python script finishes
        pythonProcess.on('close', (code) => {
            if (code === 0) {
                resolve(output.trim());  // Resolve the Promise with the output (trim any extra whitespace)
            } else {
                reject(`Python script exited with code ${code}`);
            }
        });
    });
}

const filePath = './data.txt';
let fileSize = 0;
let result = 0;

fs.watch(filePath, async (eventType) => {
    if (eventType === 'change') {
        console.log(`Detected change in ${filePath}`);

        // Get the current file size
        const stats = fs.statSync(filePath);
        const newFileSize = stats.size;

        if (newFileSize > fileSize) {
            // Read only the appended portion
            const stream = fs.createReadStream(filePath, {
                start: fileSize,
                end: newFileSize - 1,
                encoding: 'utf8',
            });

            let newData = '';
            stream.on('data', (chunk) => {
                newData += chunk;
            });

            stream.on('end', async () => {
                fileSize = newFileSize; // Update the tracked file size

                try {
                    // Parse the newly appended JSON object
                    const jsonObject1 = JSON.parse(newData.trim());

                    // Perform decryption on `jsonObj1.Data` and create `jsonObj2`
                    const decryptedData = await decrypt(jsonObject1.Dev_Address, jsonObject1.Data);

                    const jsonObject = {
                        ...jsonObject1,         // Spread the properties of jsonObj1
                        Data: decryptedData, // Replace `Data` with the decrypted value
                    };
                    const { Dev_Address } = jsonObject;

                    if (!Dev_Address) {
                        console.error('Invalid JSON object: Missing `Dev_Address` field');
                        return;
                    }

                    // Define the file path
                    const devFilePath = path.join('./temp', `${Dev_Address}.txt`);

                    // Ensure the directory exists
                    const dirPath = path.dirname(devFilePath);
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }

                    // Check if the file exists; if not, create it
                    if (!fs.existsSync(devFilePath)) {
                        fs.writeFileSync(devFilePath, '', 'utf8'); // Create an empty file
                        console.log(`File created: ${devFilePath}`);
                    } else {
                        console.log(`File already exists: ${devFilePath}`);
                    }

                    // With the following code:
                    const formattedData = jsonObject.Data
                        .replace(/[()]/g, '')  // Remove round brackets
                        .replace(/,\s*/g, ' ') // Replace commas with a single space
                        .trim();               // Trim any extra whitespace

                    fs.appendFileSync(devFilePath, formattedData + '\n');
                    fs.appendFileSync('./check_thre.txt', formattedData + '\n');

                    // fs.appendFileSync(devFilePath, JSON.stringify(jsonObject) + '\n');

                    // Check the number of lines in the file
                    const fileLines = fs.readFileSync(devFilePath, 'utf8').trim().split('\n');
                    // let result = 0
                    if (fileLines.length > 100) {
                        // Extract the first 50 lines
                        const first100Lines = fileLines.slice(0, 100);
                        const remainingLines = fileLines.slice(50);

                        // Combine the first 100 lines into a single string
                        const first100LinesString = first100Lines.join('\n');
                        // Pass the first 100 lines as a string to the Python function
                        result = await processLinesWithPython(first100LinesString);

                        console.log(`Python function result: ${result}`,'\n');

                        // Overwrite the file with the remaining lines
                        fs.writeFileSync(devFilePath, remainingLines.join('\n')+'\n');
                    }

                    if(result==0){
                        // console.log("New data is too large");
                        io.emit('Threshold1',jsonObject.Dev_Address); //green
                    }
                    else if(result==1) {
                        // fs.writeFileSync('./threshold_log.txt',`${jsonObject.Time} ${jsonObject.Fcnt}`,);
                        fs.appendFileSync('./threshold_log.txt',`${jsonObject.Time} - (Fcnt) ${jsonObject.Fcnt} - (SF) ${jsonObject.SF}\n`)
                        io.emit('Threshold',jsonObject.Dev_Address); //red
                    }

                    // Use `Dev_Address` to determine the collection name
                    const collectionName = `sensor_${Dev_Address}`;
                    const DynamicModel = getModel(collectionName);

                    // Save the new object as a document in the collection
                    const newDocument = await DynamicModel.create(jsonObject);

                    // console.log(`New document added to collection: ${collectionName}`);
                    // console.log('Document:', newDocument);
                } catch (err) {
                    console.error('Error processing JSON:', err);
                }
            });
        }
    }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'views')));
app.set('view engine', 'ejs');

// Routes
app.use('/user', userRoutes);

//*********************************************************************** */
app.get('/admin', async (req, res) => {
    const sensors = await SensorMeta.find();
    res.render('admin/dashboard', { sensors });
});

// Add Sensor Route
app.post('/admin/add', async (req, res) => {
    console.log(req.body);
    const { sensorId, type, lat, lng } = req.body;
    const sensorMeta = new SensorMeta({ sensorId, type, location: { lat, lng } });

    try {
        // Save sensor metadata to the 'SensorMeta' collection
        await sensorMeta.save();
        console.log(`New sensor added: ${sensorMeta.sensorId}`);

        // Create the collection with a specific name dynamically
        const collectionName = `sensor_${sensorId}`;
        
        // Access the MongoDB native driver and create the collection
        const db = mongoose.connection.db;

        // Check if the collection already exists
        const collections = await db.listCollections({ name: collectionName }).toArray();
        
        if (collections.length === 0) {
            // Create collection if it doesn't exist
            await db.createCollection(collectionName);
            console.log(`Collection ${collectionName} created.`);
        }

        // Now insert initial data into the collection
        const sensorCollection = db.collection(collectionName);
        await sensorCollection.insertOne({
            Dev_Address:"260B5630",
            Fcnt:0,
            Time:"0000-00-00 00:00:00",
            SF:0,
            Data:"",
            Freq:"0",
            RSSI:0,
            SNR:0,
            BW:0,
            Port:0
        });

        // Emit the new sensor to all connected clients
        io.emit('sensorUpdated', sensorMeta);
        
        res.redirect('/admin');
    } catch (err) {
        console.error('Error adding sensor:', err);
        res.status(500).send('Server Error');
    }
});

// Update Sensor Route
app.post('/admin/update/:id', async (req, res) => {
    const { type ,lat, lng } = req.body;
    
    try {
        const sensorMeta = await SensorMeta.findByIdAndUpdate(req.params.id, {
            type: type,
            location: { lat, lng },
        }, { new: true });
        
        
        // Emit the updated sensor to all connected clients
        io.emit('sensorUpdated', sensorMeta);
        
        res.redirect('/admin');
    } catch (err) {
        console.error('Error updating sensor:', err);
        res.status(500).send('Server Error');
    }
});

// Delete Sensor Route
app.post('/admin/delete/:id', async (req, res) => {
    try {
        // Find and delete the sensor from SensorMeta collection
        const deletedSensor = await SensorMeta.findByIdAndDelete(req.params.id);
        
        if (deletedSensor) {
            console.log(`Sensor deleted: ${deletedSensor.sensorId}`);
            
            // Emit the deleted sensor to all connected clients
            io.emit('sensorDelete', deletedSensor);

            // Now delete the collection associated with this sensor
            const collectionName = `sensor_${deletedSensor.sensorId}`;

            // Access the MongoDB native driver and delete the collection
            const db = mongoose.connection.db;

            try {
                await db.collection(collectionName).drop();
                console.log(`Collection ${collectionName} deleted.`);
            } catch (err) {
                console.error(`Error deleting collection ${collectionName}:`, err);
            }

            res.redirect('/admin');
        } else {
            res.status(404).send('Sensor not found');
        }
    } catch (err) {
        console.error('Error deleting sensor:', err);
        res.status(500).send('Server Error');
    }
});

app.post('/admin/hardreset/', async (req, res) => {
    io.emit('hardDeleted');
    try {
        console.log('Hard Reset received');

        // Access the MongoDB native driver
        const db = mongoose.connection.db;

        // Fetch all collections with the prefix 'sensor_'
        const collections = await db.listCollections({}).toArray();
        const sensorCollections = collections.filter(c => c.name.startsWith('sensor_'));

        // Drop each collection with the prefix 'sensor_'
        for (const collection of sensorCollections) {
            try {
                await db.collection(collection.name).drop();
                console.log(`Collection ${collection.name} deleted.`);
            } catch (err) {
                console.error(`Error deleting collection ${collection.name}:`, err);
            }
        }

        // Clear all documents in the `SensorMeta` collection
        await SensorMeta.deleteMany({});
        console.log('All documents in SensorMeta collection deleted.');

        // Notify all connected clients about the reset
        io.emit('HardResetComplete', 'All sensor data and metadata have been cleared.');
        res.redirect('/admin');

    } catch (err) {
        console.error('Error handling HardReset:', err);
        io.emit('HardResetError', 'An error occurred while performing the reset.');
    }

})

app.post('/admin/softreset/:id', async (req, res) => {
    const { id } = req.params; // Extract the ID from the route parameters
    const collectionName = `sensor_${id}`; // Dynamically generate the collection name

    try {
        // Access the dynamically named collection
        const collection = db.collection(collectionName);

        // Delete all documents in the collection
        const result = await collection.deleteMany({});

        if (result.deletedCount > 0) {
            console.log(`Successfully deleted ${result.deletedCount} documents from ${collectionName}`);
            res.redirect('/admin');
        } else {
            console.log(`No documents found in ${collectionName}`);
            res.redirect('/admin');
        }
    } catch (error) {
        console.error(`Error deleting documents from collection '${collectionName}':`, error);
        res.status(500).send('An error occurred while attempting to delete documents.');
    }
});

//*********************************************************************** */

app.get('/check',(req,res)=>{
    io.emit('do','ami udit');
    return res.end();
})


// Real-time data socket
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    socket.on('getSensorData', async (Dev_Address) => {
        try {
            // Dynamically determine the collection name
            const collectionName = `sensor_${Dev_Address}`;
            
            // Fetch the collection
            const collection = db.collection(collectionName);
    
            // Query the 1000 most recent documents from the collection
            const recentData = await collection
                .find({})
                .sort({ Time: -1 }) // Sort by the `Time` field in descending order
                .limit(1000) // Limit to 1000 documents
                .toArray(); // Convert the cursor to an array
    
            if (!recentData || recentData.length === 0) {
                console.log(`No data found for ${collectionName}`);
                socket.emit('realTimeData', { Dev_Address, data_sensor: [] });
                return;
            }
            
            console.log(`Fetched ${recentData.length} records for ${collectionName}`);
            socket.emit('realTimeData', { Dev_Address, data_sensor: recentData });
        } catch (err) {
            console.error('Error in getSensorData handler:', err);
            socket.emit('realTimeData', { Dev_Address, data_sensor: [] });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

// Start server
const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

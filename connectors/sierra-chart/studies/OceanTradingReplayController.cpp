// Ocean Trading Replay Controller
//
// Replay-only ACSIL bridge for the Sierra Chart connector. This study reads a
// command file written by the Node connector and calls Sierra Chart replay APIs
// from inside the replay instance. Do not load this study on live charts.

#include "sierrachart.h"

#include <fstream>
#include <sstream>
#include <string>

SCDLLName("Ocean Trading Replay Controller")

namespace {

const char* VERSION = "v0.1.1";

std::string ReadTextFile(const SCString& path)
{
    std::ifstream input(path.GetChars(), std::ios::in | std::ios::binary);
    if (!input.is_open())
        return "";

    std::ostringstream buffer;
    buffer << input.rdbuf();
    return buffer.str();
}

void WriteTextFile(const SCString& path, const std::string& text)
{
    std::ofstream output(path.GetChars(), std::ios::out | std::ios::binary | std::ios::trunc);
    if (output.is_open())
        output << text;
}

std::string JsonEscape(const std::string& value)
{
    std::string escaped;
    for (char ch : value)
    {
        if (ch == '"' || ch == '\\')
        {
            escaped.push_back('\\');
            escaped.push_back(ch);
        }
        else if (ch == '\n')
        {
            escaped += "\\n";
        }
        else if (ch == '\r')
        {
            escaped += "\\r";
        }
        else
        {
            escaped.push_back(ch);
        }
    }
    return escaped;
}

std::string ExtractJsonString(const std::string& json, const char* key)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return "";

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return "";

    size_t firstQuote = colonPos + 1;
    while (firstQuote < json.size() && (json[firstQuote] == ' ' || json[firstQuote] == '\t' || json[firstQuote] == '\r' || json[firstQuote] == '\n'))
        ++firstQuote;

    if (firstQuote >= json.size() || json[firstQuote] != '"')
        return "";

    std::string value;
    bool escaped = false;
    for (size_t index = firstQuote + 1; index < json.size(); ++index)
    {
        const char ch = json[index];
        if (escaped)
        {
            value.push_back(ch);
            escaped = false;
        }
        else if (ch == '\\')
        {
            escaped = true;
        }
        else if (ch == '"')
        {
            return value;
        }
        else
        {
            value.push_back(ch);
        }
    }
    return "";
}

int ExtractJsonInt(const std::string& json, const char* key, const int fallback)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return fallback;

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return fallback;

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t'))
        ++valueStart;

    return std::atoi(json.c_str() + valueStart);
}

bool ExtractJsonBool(const std::string& json, const char* key, const bool fallback)
{
    const std::string marker = std::string("\"") + key + "\"";
    const size_t keyPos = json.find(marker);
    if (keyPos == std::string::npos)
        return fallback;

    const size_t colonPos = json.find(':', keyPos + marker.size());
    if (colonPos == std::string::npos)
        return fallback;

    size_t valueStart = colonPos + 1;
    while (valueStart < json.size() && (json[valueStart] == ' ' || json[valueStart] == '\t'))
        ++valueStart;

    return json.compare(valueStart, 4, "true") == 0;
}

bool ParseDateTime(const std::string& text, SCDateTime& output)
{
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    if (std::sscanf(text.c_str(), "%d-%d-%d %d:%d:%d", &year, &month, &day, &hour, &minute, &second) != 6)
        return false;

    output.SetDateTimeYMDHMS(year, month, day, hour, minute, second);
    return true;
}

std::string DateTimeToText(const SCDateTime& value)
{
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    value.GetDateYMD(year, month, day);
    value.GetTimeHMS(hour, minute, second);

    char buffer[32] = {};
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d %02d:%02d:%02d", year, month, day, hour, minute, second);
    return buffer;
}

SCString DefaultControlDir(SCStudyInterfaceRef sc)
{
    SCString path = sc.DataFilesFolder();
    path += "\\..\\connector-control";
    return path;
}

void WriteStatus(
    SCStudyInterfaceRef sc,
    const SCString& statusPath,
    const std::string& commandId,
    const std::string& action,
    const std::string& requestedStart,
    const std::string& replaySpeed,
    const std::string& status,
    const std::string& error)
{
    SCDateTime currentDateTime = sc.BaseDateTimeIn[sc.ArraySize > 0 ? sc.ArraySize - 1 : 0];
    std::ostringstream json;
    json
        << "{\n"
        << "  \"schema\": \"ocean-trading.sierra-replay-controller.status.v1\",\n"
        << "  \"controllerVersion\": \"" << VERSION << "\",\n"
        << "  \"commandId\": \"" << JsonEscape(commandId) << "\",\n"
        << "  \"action\": \"" << JsonEscape(action) << "\",\n"
        << "  \"status\": \"" << JsonEscape(status) << "\",\n"
        << "  \"chartNumber\": " << sc.ChartNumber << ",\n"
        << "  \"requestedStartDateTime\": \"" << JsonEscape(requestedStart) << "\",\n"
        << "  \"currentChartDateTime\": \"" << JsonEscape(DateTimeToText(currentDateTime)) << "\",\n"
        << "  \"replaySpeed\": \"" << JsonEscape(replaySpeed) << "\",\n"
        << "  \"isReplayRunning\": " << (sc.IsReplayRunning() ? "true" : "false") << ",\n"
        << "  \"error\": " << (error.empty() ? "null" : ("\"" + JsonEscape(error) + "\"")) << "\n"
        << "}\n";
    WriteTextFile(statusPath, json.str());
}

} // namespace

SCSFExport scsf_OceanTradingReplayController(SCStudyInterfaceRef sc)
{
    SCInputRef CommandFilePath = sc.Input[0];
    SCInputRef StatusFilePath = sc.Input[1];
    SCInputRef EnableController = sc.Input[2];

    if (sc.SetDefaults)
    {
        sc.GraphName = "Ocean Trading Replay Controller v0.1.1";
        sc.StudyDescription = "Replay-only command bridge for Ocean Trading Sierra connector.";
        sc.AutoLoop = 0;
        sc.UpdateAlways = 1;
        sc.GraphRegion = 0;
        sc.HideStudy = 1;

        CommandFilePath.Name = "Command File Path";
        CommandFilePath.SetPathAndFileName("");

        StatusFilePath.Name = "Status File Path";
        StatusFilePath.SetPathAndFileName("");

        EnableController.Name = "Enable Replay Controller";
        EnableController.SetYesNo(1);
        return;
    }

    if (!EnableController.GetYesNo())
        return;

    SCString commandPath = CommandFilePath.GetPathAndFileName();
    SCString statusPath = StatusFilePath.GetPathAndFileName();
    if (commandPath.IsEmpty() || statusPath.IsEmpty())
    {
        const SCString controlDir = DefaultControlDir(sc);
        if (commandPath.IsEmpty())
        {
            commandPath = controlDir;
            commandPath += "\\replay-command.json";
        }
        if (statusPath.IsEmpty())
        {
            statusPath = controlDir;
            statusPath += "\\replay-status.json";
        }
    }

    const std::string commandText = ReadTextFile(commandPath);
    if (commandText.empty())
        return;

    const std::string commandId = ExtractJsonString(commandText, "commandId");
    const int lastCommandHash = sc.GetPersistentInt(1);
    int currentCommandHash = 0;
    for (char ch : commandId)
        currentCommandHash = (currentCommandHash * 131) + ch;

    if (commandId.empty() || currentCommandHash == lastCommandHash)
        return;

    sc.SetPersistentInt(1, currentCommandHash);

    const std::string action = ExtractJsonString(commandText, "action");
    const std::string requestedStart = ExtractJsonString(commandText, "startDateTime");
    const std::string replaySpeed = ExtractJsonString(commandText, "replaySpeed");
    const int chartNumber = ExtractJsonInt(commandText, "chartNumber", sc.ChartNumber);
    const int speedMultiplier = ExtractJsonInt(commandText, "replaySpeedMultiplier", 480);
    const bool clearTradeData = ExtractJsonBool(commandText, "clearTradeSimulationData", true);
    const bool skipEmptyPeriods = ExtractJsonBool(commandText, "skipEmptyPeriods", true);

    std::string error;
    std::string status = "accepted";

    if (action == "start")
    {
        SCDateTime startDateTime;
        if (!ParseDateTime(requestedStart, startDateTime))
        {
            error = "Invalid or missing startDateTime";
            status = "error";
        }
        else
        {
            n_ACSIL::s_ChartReplayParameters params;
            params.ChartNumber = chartNumber;
            params.StartDateTime = startDateTime;
            params.ReplaySpeed = speedMultiplier;
            params.SkipEmptyPeriods = skipEmptyPeriods;
            params.ClearExistingTradeSimulationDataForSymbolAndTradeAccount = clearTradeData;
            params.ReplayMode = n_ACSIL::REPLAY_MODE_ACCURATE_TRADING_SYSTEM_BACK_TEST;
            sc.StartChartReplayNew(params);
            status = "start_requested";
        }
    }
    else if (action == "stop")
    {
        sc.StopChartReplay(chartNumber);
        status = "stop_requested";
    }
    else if (action == "pause")
    {
        sc.PauseChartReplay(chartNumber);
        status = "pause_requested";
    }
    else if (action == "resume")
    {
        sc.ResumeChartReplay(chartNumber);
        status = "resume_requested";
    }
    else if (action == "status")
    {
        status = "status";
    }
    else
    {
        error = "Unsupported action";
        status = "error";
    }

    WriteStatus(sc, statusPath, commandId, action, requestedStart, replaySpeed, status, error);
}

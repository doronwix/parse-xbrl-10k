(function () {
  "use strict";

  const Promise = require("bluebird");
  const fs = Promise.promisifyAll(require("fs"));
  const _ = require("lodash");
  const xmlParser = require("xml2json");
  const parser = require("fast-xml-parser");
  const FundamentalAccountingConcepts = require("./FundamentalAccountingConcepts.js");

  function parse(filePath) {
    return new Promise(function (resolve, reject) {
      // Load xml and parse to json
      fs.readFileAsync(filePath, "utf8")
        .then(function (data) {
          new parseStr(data)
            .then(function (data) {
              resolve(data);
            })
            .catch(function (err) {
              console.log(err);
            });
        })
        .catch(function (err) {
          reject("Problem with reading file", err);
        });
    });
  }
  function parseStr(data, fieldCount = -1) {
    var self = this;

    self.loadYear = ()=>{ 
      return self.fields["DocumentPeriodEndDate"] 
    };
    self.loadField = loadField;
    self.getFactValue = getFactValue;
    self.documentJson;
    self.fields = {};
    self.getNodeList = getNodeList;
    self.getContextForInstants = getContextForInstants;
    self.getContextForDurations = getContextForDurations;
    self.lookForAlternativeInstanceContext = lookForAlternativeInstanceContext;

    return new Promise(function (resolve, reject) {
      // Loadvar jsonObj = JSON.parse(xmlParser.toJson(data));
      var jsonObj = parser.parse(data, {
        textNodeName: "$t",
        attributeNamePrefix : "",
        ignoreAttributes : false,
        ignoreNameSpace : false,
        allowBooleanAttributes : false,
        parseNodeValue : true,
        parseAttributeValue : true,
        trimValues: true,
      });
     
      //if (parser.validate(data) === true) {
      //optional (it'll return an object in case it's not valid)
      //var jsonObj = parser.parse(data, {});
      //}

      self.documentJson = jsonObj[Object.keys(jsonObj)[0]];

      // Calculate and load basic facts from json doc
      self.loadField("EntityRegistrantName");
      self.loadField("CurrentFiscalYearEndDate");
      self.loadField("EntityCentralIndexKey");
      self.loadField("EntityFilerCategory");
      self.loadField("TradingSymbol");
      self.loadField("DocumentPeriodEndDate");
      self.loadField("DocumentFiscalYearFocus");
      self.loadField("DocumentFiscalPeriodFocus");
      self.loadField(
        "DocumentFiscalYearFocus",
        "DocumentFiscalYearFocusContext",
        "contextRef"
      );
      self.loadField(
        "DocumentFiscalPeriodFocus",
        "DocumentFiscalPeriodFocusContext",
        "contextRef"
      );
      self.loadField("DocumentType");

      var currentYearEnd = self.fields["DocumentPeriodEndDate"];
      if (currentYearEnd) {
        var durations = self.getContextForDurations(currentYearEnd);

        self.fields["BalanceSheetDate"] = durations.balanceSheetDate;
        self.fields["IncomeStatementPeriodYTD"] =
          durations.incomeStatementPeriodYTD;
        self.fields["ContextForInstants"] = self.getContextForInstants(
          currentYearEnd
        );
        self.fields["ContextForDurations"] = durations.contextForDurations;
        self.fields["BalanceSheetDate"] = currentYearEnd;

        // Load the rest of the facts
        FundamentalAccountingConcepts.load(self, fieldCount);
        resolve(self.fields);
      } else {
        reject("No year end found.");
      }
    });

    // Utility functions
    function loadField(conceptToFind, fieldName, key) {
      key = key || "$t";
      fieldName = fieldName || conceptToFind;
      var concept = _.get(self.documentJson, "dei:" + conceptToFind);
      //console.log(fieldName + "=> " + JSON.stringify(concept, null, 3));
      if (_.isArray(concept)) {
        // warn about multliple concepts...
        console.warn("Found " + concept.length + " context references");
        _.forEach(concept, function (conceptInstance, idx) {
          console.warn(
            "=> " +
              conceptInstance.contextRef +
              (idx === 0 ? " (selected)" : "")
          );
        });

        // ... then default to the first available contextRef
        concept = _.find(concept, function (conceptInstance, idx) {
          return idx === 0;
        });
      }
      self.fields[fieldName] = _.get(concept, key, "Field not found.");

      console.log(`loaded ${fieldName}: ${self.fields[fieldName]}`);
    }

    function getFactValue(concept, periodType) {
      var contextReference;
      var factNode;
      var factValue;

      if (periodType === "Instant") {
        contextReference = self.fields["ContextForInstants"];
      } else if (periodType === "Duration") {
        contextReference = self.fields["ContextForDurations"];
      } else {
        console.warn("CONTEXT ERROR");
      }

      _.forEach(_.get(self.documentJson, _.trim(concept)), function (node) {
        if (
          node.contextRef &&
          (node.contextRef == contextReference ||
            node.contextRef.indexOf(contextReference + "_us-gaap") > 0)
        ) {
          factNode = node;
        }
      });

      if (factNode) {
        factValue = factNode["$t"];

        for (var key in factNode) {
          if (key.indexOf("nil") >= 0) {
            factValue = 0;
          }
        }
        if (typeof factValue === "string") {
          factValue = Number(factValue);
        }
      } else {
        return null;
      }

      return factValue;
    }

/*     function loadYear() {
      var currentEnd = self.fields["DocumentPeriodEndDate"];
      if (currentEnd.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)) {
        return currentEnd;
      } else {
        console.warn(currentEnd + " is not a date");
        return false;
      }
    } */

    function getNodeList(nodeNamesArr, root) {
      root = root || self.documentJson;
      var allNodes = [];

      for (var i = 0; i < nodeNamesArr.length; i++) {
        allNodes = allNodes.concat(_.get(root, nodeNamesArr[i]));
      }

      // Remove undefined nodes
      return _.filter(allNodes, function (node) {
        if (node) {
          return true;
        }
      });
    }

    function getContextForInstants(endDate) {
      var contextForInstants = null;
      var contextId;
      var contextPeriods;
      var contextPeriod;
      var instanceHasExplicitMember;

      // Uses the concept ASSETS to find the correct instance context
      var instanceNodesArr = self.getNodeList([
        "us-gaap:Assets",
        "us-gaap:AssetsCurrent",
        "us-gaap:LiabilitiesAndStockholdersEquity",
      ]);

      for (var i = 0; i < instanceNodesArr.length; i++) {
        contextId =
          instanceNodesArr[i].contextRef ||
          "FI" + self.fields["DocumentFiscalYearFocus"] + "Q4";
        contextPeriods =
          _.get(self.documentJson, "xbrli:context") ||
          _.get(self.documentJson, "context");

        _.forEach(contextPeriods, function (period) {
          if (period.id === contextId) {
            contextPeriod =
              _.get(period, ["xbrli:period", "xbrli:instant"]) ||
              _.get(period, ["period", "instant"]);

            if (contextPeriod && contextPeriod === endDate) {
              instanceHasExplicitMember =
                _.get(
                  period,
                  ["xbrli:entity", "xbrli:segment", "xbrldi:explicitMember"],
                  false
                ) ||
                _.get(period, ["entity", "segment", "explicitMember"], false);
              if (instanceHasExplicitMember) {
                // console.log('Instance has explicit member.');
              } else {
                contextForInstants = contextId;
                // console.log('Use Context:', contextForInstants);
              }
            }
          }
        });
      }

      if (contextForInstants === null) {
        contextForInstants = self.lookForAlternativeInstanceContext();
      }

      return contextForInstants;
    }

    function getContextForDurations(endDate) {
      var contextForDurations = null;
      var contextId;
      var contextPeriod;
      var durationHasExplicitMember;
      var startDateYTD = "2099-01-01";
      if (self.fields["DocumentType"] === "10-Q") {
        startDateYTD = "1970-01-01";
      }
      var startDate;
      var context_length;

      var durationNodesArr = self.getNodeList([
        "us-gaap:CashAndCashEquivalentsPeriodIncreaseDecrease",
        "us-gaap:CashPeriodIncreaseDecrease",
        "us-gaap:NetIncomeLoss",
        "dei:DocumentPeriodEndDate",
      ]);
      for (var k = 0; k < durationNodesArr.length; k++) {
        contextId = durationNodesArr[k].contextRef;

        _.forEach(
          _.get(self.documentJson, "xbrli:context") ||
            _.get(self.documentJson, "context"),
          function (period) {
            if (period.id === contextId) {
              contextPeriod =
                _.get(period, ["xbrli:period", "xbrli:endDate"]) ||
                _.get(period, ["period", "endDate"]);

              if (contextPeriod === endDate) {
                durationHasExplicitMember =
                  _.get(
                    period,
                    ["xbrli:entity", "xbrli:segment", "xbrldi:explicitMember"],
                    false
                  ) ||
                  _.get(period, ["entity", "segment", "explicitMember"], false);

                if (durationHasExplicitMember) {
                  // console.log('Duration has explicit member.');
                } else {
                  startDate =
                    _.get(period, ["xbrli:period", "xbrli:startDate"]) ||
                    _.get(period, ["period", "startDate"]);

                  // console.log('Context start date:', startDate);
                  // console.log('YTD start date:', startDateYTD);
                  if (self.fields["DocumentType"] === "10-Q") {
                    //shortest start date
                    if (startDate >= startDateYTD) {
                      if (
                        period.id.match(/C_(\d{5,10})_(\d{6,8})_(\d{6,8})/) ||
                        period.id.match(/FD\d{4}Q.*QTD/)
                      ) {
                        startDateYTD = startDate;
                        contextForDurations = _.get(period, "id");
                      } else if (period.id.match(/FD\d{4}Q.*YTD/)) {
                        startDateYTD = startDate;
                        contextForDurations = _.get(period, "id");
                      }
                    }
                  } else {
                    //longest start date
                    if (startDate <= startDateYTD) {
                      startDateYTD = startDate;
                      contextForDurations = _.get(period, "id");
                    }
                  }
                }
              }
            }
          }
        );
      }

      return {
        contextForDurations: contextForDurations,
        incomeStatementPeriodYTD: startDateYTD,
      };
    }

    function lookForAlternativeInstanceContext() {
      var altContextId = null;
      var altNodesArr = _.filter(
        _.get(self.documentJson, [
          "xbrli:context",
          "xbrli:period",
          "xbrli:instant",
        ]) || _.get(self.documentJson, ["context", "period", "instant"]),
        function (node) {
          if (node === self.fields["BalanceSheetDate"]) {
            return true;
          }
        }
      );

      for (var h = 0; h < altNodesArr.length; h++) {
        _.forEach(_.get(self.documentJson, ["us-gaap:Assets"]), function (
          node
        ) {
          if (node.contextRef === altNodesArr[h].id) {
            altContextId = altNodesArr[h].id;
          }
        });
      }
      return altContextId;
    }
  }

  exports.parse = parse;
  exports.parseStr = parseStr;
})();
